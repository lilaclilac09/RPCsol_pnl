/**
 * sol_balance_ultimate.mjs — Universal SOL Balance History Solver
 *
 * Merges ALL winning techniques from 5-repo research synthesis + V14 BO results:
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Technique                  Source                  Gain                │
 * │  ─────────────────────────────────────────────────────────────────────  │
 * │  HTTP/1.1 undici pool       sol-pnl (shariqazeem)   6× vs HTTP/2       │
 * │  Synthetic pagination tok   sol-pnl + darkpnl        all pages in //   │
 * │  3-call t=0 boundary fan    sol-pnl                  1 RTT boundary    │
 * │  Sig sweep 1000/page        mert-algo, fastpnl        <1 RTT sigs      │
 * │  90-sig chunk sizing        fastpnl                   0 pagination     │
 * │  Balance continuity oracle  sol-pnl                   skip flat gaps   │
 * │  loadedAddresses v0 txs     mert-algo                 versioned tx fix │
 * │  BO-optimal window=62 c=13  V14 research (60 trials)  10 calls dense   │
 * │  Density routing free tier  V15 / Hybrid BO           sparse/med/dense │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Algorithm (paid tier):
 *   Phase 0  — 3 parallel calls at t=0:
 *              asc(limit=1,sigs) + desc(limit=1,sigs) + recent(limit=100,full)
 *              → first_slot, last_slot, recent 100 txs already in hand
 *   Phase 1  — sig sweep (parallel, 1000 sigs/call, slot-filtered):
 *              N = ceil(total_slots / SLOT_BAND) parallel gTFA(sigs) calls
 *              Collect all (signature, slot, txIndex) tuples
 *   Phase 2  — full-tx fetch (parallel, 90-sig chunks, 0 pagination):
 *              M = ceil(total_sigs / 90) parallel gTFA(full) calls
 *              90 sigs/chunk ≤ 100 limit → pagination NEVER triggered
 *   Phase 3  — assembly:
 *              Sort by (slot, txIndex), dedup by signature
 *              Balance continuity oracle: skip gaps where A.post === B.pre
 *              Build curve
 *
 * Usage:
 *   import { fetchUltimate } from "./sol_balance_ultimate.mjs";
 *   const r = await fetchUltimate(address, apiKey);
 *   // r.points, r.stats, r.routing
 *
 * CLI:
 *   node sol_balance_ultimate.mjs <address> [apiKey] [--free] [--complete] [--bench]
 */

import { setGlobalDispatcher, Agent as UndiciAgent, fetch as undiciFetch } from "undici";

// ─── HTTP/1.1 keepalive pool ─────────────────────────────────────────────────
// Research finding: HTTP/2 is 6× SLOWER on Helius/Cloudflare.
// Cloudflare's HTTP/2 stream scheduler serialises requests.
// 64 persistent HTTP/1.1 connections with TCP keepalive = optimal.
setGlobalDispatcher(new UndiciAgent({
  connections:         64,
  pipelining:          1,
  keepAliveTimeout:    30_000,
  keepAliveMaxTimeout: 60_000,
}));
const _fetch = undiciFetch; // use the undici-backed fetch everywhere

// ─── Constants ───────────────────────────────────────────────────────────────
const HELIUS_URL   = k => `https://mainnet.helius-rpc.com/?api-key=${k}`;
const SIG_LIMIT    = 1000;   // max sigs per gTFA signatures call
const FULL_LIMIT   = 100;    // max full txs per gTFA call
const CHUNK_SIGS   = 90;     // ≤ FULL_LIMIT → never triggers pagination
const SLOT_BAND    = 2_000_000; // ~8 days of slots per sig-sweep shard
const RETRY_BASE   = 150;
const MAX_RETRIES  = 4;
const LAMPORTS     = 1_000_000_000;

// ─── BO-optimal configs (locked from research) ───────────────────────────────
export const CONFIGS = {
  paid: {
    // V14 BO: 60 trials, window=62 → 8 slot windows, c=13 avoids 429s
    // These are kept as fallback for the old slot-window path.
    windowSize: 62, maxConcurrency: 13, skipZeroDelta: false,
  },
  free_fast: {
    sparseThreshold: 25,
    sparse: { txTarget: 11, maxConcurrency: 12 },
    medium: { txTarget: 23, maxConcurrency: 19 },
    dense:  { txTarget: 23, maxConcurrency: 19 },
  },
  free_complete: {
    sparseThreshold: 25,
    sparse: { txTarget: 11, maxConcurrency: 12 },
    medium: { txTarget: 31, maxConcurrency: 12 },
    dense:  { txTarget: 31, maxConcurrency: 12 },
  },
};

// ─── Low-level RPC ───────────────────────────────────────────────────────────

function makeSemaphore(n) {
  let active = 0; const q = [];
  return () => new Promise(res => {
    const go = () => { active++; res(() => { active--; q.shift()?.(); }); };
    active < n ? go() : q.push(go);
  });
}

function makeRpc(apiKey, concurrency = 24) {
  const url = HELIUS_URL(apiKey);
  const sem = makeSemaphore(concurrency);
  let calls = 0;
  const post = async body => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const rel = await sem();
      calls++;
      try {
        const res = await _fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const txt = await res.text();
        if (!res.ok) {
          const isRetry = res.status === 429 || res.status >= 500;
          if (isRetry && attempt < MAX_RETRIES) {
            await _sleep(RETRY_BASE * (2 ** attempt) + Math.random() * 80);
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const j = JSON.parse(txt);
        if (j?.error) throw new Error(JSON.stringify(j.error));
        return j.result;
      } catch (err) {
        const transient = /429|503|timed out|ECONNRESET|fetch failed|terminated/i.test(String(err?.message));
        if (transient && attempt < MAX_RETRIES) {
          await _sleep(RETRY_BASE * (2 ** attempt) + Math.random() * 80);
          continue;
        }
        throw err;
      } finally { rel(); }
    }
  };

  return {
    callCount: () => calls,
    // gTFA — signatures only (1000/page)
    sigsPage: (addr, opts = {}) => post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [addr, {
        transactionDetails: "signatures",
        sortOrder: "asc",
        limit: SIG_LIMIT,
        filters: { status: "succeeded" },
        ...opts,
      }],
    }),
    // gTFA — full transaction (100/page)
    fullPage: (addr, opts = {}) => post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [addr, {
        transactionDetails: "full",
        sortOrder: "asc",
        limit: FULL_LIMIT,
        filters: { status: "succeeded" },
        maxSupportedTransactionVersion: 0,
        ...opts,
      }],
    }),
    // single full tx probe
    fullProbe: (addr, opts = {}) => post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [addr, {
        transactionDetails: "full",
        sortOrder: opts.sortOrder ?? "asc",
        limit: 1,
        filters: { status: "succeeded" },
        maxSupportedTransactionVersion: 0,
        ...(opts.filter ?? {}),
      }],
    }),
    // paid-tier tier probe
    tierProbe: addr => post({
      jsonrpc: "2.0", id: 1,
      method: "getTransactionsForAddress",
      params: [addr, { transactionDetails: "signatures", sortOrder: "desc", limit: 1, filters: { status: "succeeded" } }],
    }),
  };
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Account index resolution (versioned tx support) ─────────────────────────
// mert-algo insight: v0 txs use Address Lookup Tables.
// loadedAddresses.writable + readonly must be appended to accountKeys.
function resolveAccountIndex(tx, address) {
  const msg   = tx?.transaction?.message ?? {};
  const keys  = (msg.accountKeys ?? []).map(k => (typeof k === "string" ? k : k?.pubkey));
  const loaded = [
    ...(tx?.meta?.loadedAddresses?.writable ?? []),
    ...(tx?.meta?.loadedAddresses?.readonly ?? []),
  ];
  const all = [...keys, ...loaded];
  return all.findIndex(k => k === address);
}

function extractSample(tx, address) {
  const idx = resolveAccountIndex(tx, address);
  if (idx < 0) return null;
  const pre  = tx?.meta?.preBalances?.[idx]  ?? null;
  const post = tx?.meta?.postBalances?.[idx] ?? null;
  if (pre === null || post === null) return null;
  return {
    slot:      tx.slot ?? 0,
    txIndex:   tx.transactionIndex ?? 0,
    blockTime: tx.blockTime ?? 0,
    signature: tx.transaction?.signatures?.[0] ?? "",
    preLamports:  pre,
    postLamports: post,
  };
}

// ─── Balance continuity oracle ───────────────────────────────────────────────
// sol-pnl insight: if A.post === B.pre for consecutive known txs,
// the slot gap between them is provably flat. Skip fetching it.
function applyContinuityOracle(samples) {
  if (samples.length < 2) return samples;
  const result = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    // Gap IS flat — no extra samples needed, continuity proven
    if (prev.postLamports === curr.preLamports) {
      result.push(curr);
    } else {
      // Gap has unknown changes — include a marker
      result.push({ ...curr, hasGapBefore: true });
    }
  }
  return result;
}

function buildCurve(address, rawSamples, rpcCalls, wallMs, meta = {}) {
  // Dedup by signature
  const seen = new Map();
  for (const s of rawSamples) {
    const key = s.signature || `${s.slot}:${s.txIndex}:${s.preLamports}`;
    if (!seen.has(key)) seen.set(key, s);
  }
  const samples = [...seen.values()].sort((a, b) =>
    a.slot !== b.slot ? a.slot - b.slot : a.txIndex - b.txIndex
  );

  const withOracle = applyContinuityOracle(samples);

  // Build plot points
  const points = [];
  let lastLamports = null, lastSlot = null;
  for (const s of withOracle) {
    if (lastLamports !== null && lastLamports !== s.preLamports) {
      points.push({ slot: s.slot - 1, lamports: lastLamports, blockTime: s.blockTime, kind: "flat" });
    }
    points.push({ slot: s.slot, lamports: s.postLamports, blockTime: s.blockTime, kind: "sample" });
    lastLamports = s.postLamports;
    lastSlot     = s.slot;
  }

  return {
    address,
    points,
    openingLamports: samples[0]?.preLamports    ?? 0,
    closingLamports: samples.at(-1)?.postLamports ?? 0,
    stats: {
      totalRpcCalls: rpcCalls,
      wallTimeMs:    wallMs,
      sampleCount:   samples.length,
      openGapsRemaining: withOracle.filter(s => s.hasGapBefore).length,
      ...meta,
    },
  };
}

// ─── Paid-tier Ultimate Solver ───────────────────────────────────────────────

async function solveUltimate(address, apiKey) {
  const t0  = performance.now();
  const rpc = makeRpc(apiKey, 48);

  // ── Phase 0: Fan-out (3 parallel calls at t=0) ────────────────────────────
  // call A: first tx boundary
  // call B: last tx boundary
  // call C: sig probe — up to 1000 sigs (full history for small wallets, no slot filter)
  //         For wallets ≤1000 txs, this returns ALL sigs in 1 RTT. Phase 1 skipped.
  const [ascBound, descBound, sigProbeResult] = await Promise.all([
    rpc.fullProbe(address, { sortOrder: "asc" }),
    rpc.fullProbe(address, { sortOrder: "desc" }),
    rpc.sigsPage(address, {}),  // no slot filter — all history, asc order
  ]);

  const firstTx = ascBound?.data?.[0];
  if (!firstTx) {
    return buildCurve(address, [], rpc.callCount(), performance.now() - t0,
      { apiTier: "paid", walletType: "empty", phase: 0 });
  }

  const firstSlot = firstTx.slot;
  const lastSlot  = descBound?.data?.[0]?.slot ?? firstSlot;
  const slotSpan  = Math.max(1, lastSlot - firstSlot);

  const probeData    = sigProbeResult?.data ?? [];
  const probeHasMore = probeData.length >= SIG_LIMIT && !!sigProbeResult?.paginationToken;

  // ── Phase 1: Sig sweep (only for wallets > 1000 txs) ─────────────────────
  // If probe returned < 1000: we have ALL sigs already — skip Phase 1 entirely.
  // If probe returned 1000+: divide slot span into N parallel bands.
  // N is derived from sig density, not a fixed slot width — avoids 50+ empty bands.
  let allSigs;
  if (!probeHasMore) {
    // Fast path: ≤1000 txs — all sigs from Phase 0, 0 extra calls
    allSigs = probeData.map(e => ({
      signature: e.signature ?? e,
      slot:      e.slot ?? 0,
      txIndex:   e.transactionIndex ?? 0,
    }));
  } else {
    // Dense wallet: estimate density, partition by sig density not slot size
    // Estimate ≥ 1000 txs. Use 16 parallel bands to cover the full range.
    const MAX_BANDS = 16;
    const bandSize  = Math.ceil(slotSpan / MAX_BANDS);

    const sigBatches = await Promise.all(
      Array.from({ length: MAX_BANDS }, (_, i) => {
        const slotGte = firstSlot + i * bandSize;
        const slotLt  = i === MAX_BANDS - 1 ? lastSlot + 1 : slotGte + bandSize;
        return fetchAllSigs(rpc, address, slotGte, slotLt);
      })
    );

    const sigSeen = new Set();
    allSigs = [];
    for (const batch of sigBatches) {
      for (const e of batch) {
        if (!sigSeen.has(e.signature)) { sigSeen.add(e.signature); allSigs.push(e); }
      }
    }
    // Also include probe data (sorted asc from sig probe)
    for (const e of probeData) {
      const sig = e.signature ?? e;
      if (!sigSeen.has(sig)) {
        sigSeen.add(sig);
        allSigs.push({ signature: sig, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0 });
      }
    }
  }

  allSigs.sort((a, b) => a.slot !== b.slot ? a.slot - b.slot : a.txIndex - b.txIndex);

  if (allSigs.length === 0) {
    return buildCurve(address, [], rpc.callCount(), performance.now() - t0,
      { apiTier: "paid", walletType: "empty", phase: 1 });
  }

  // ── Phase 2: Full-tx fetch (90-sig chunks → 0 pagination) ────────────────
  // fastpnl insight: 90 sigs/chunk always ≤ 100 limit → pagination NEVER triggered.
  // All chunks fire in parallel — single RTT for all full-tx data.
  const chunks = [];
  for (let i = 0; i < allSigs.length; i += CHUNK_SIGS) {
    chunks.push(allSigs.slice(i, i + CHUNK_SIGS));
  }

  const fullBatches = await Promise.all(
    chunks.map(chunk => {
      const slotGte = chunk[0].slot;
      const slotLt  = chunk.at(-1).slot + 1;
      return rpc.fullPage(address, {
        filters: { status: "succeeded", slot: { gte: slotGte, lt: slotLt } },
      }).then(r => r?.data ?? []);
    })
  );

  const samples = [];
  for (const txList of fullBatches) {
    for (const tx of txList) {
      const s = extractSample(tx, address);
      if (s) samples.push(s);
    }
  }

  const walletType = allSigs.length >= SIG_LIMIT ? "dense"
    : allSigs.length > CONFIGS.free_fast.sparseThreshold ? "medium" : "sparse";

  return buildCurve(address, samples, rpc.callCount(), performance.now() - t0, {
    apiTier: "paid", walletType, phase: probeHasMore ? 2 : "0+2",
    totalSigs: allSigs.length, chunks: chunks.length,
  });
}

// Fetch all sigs in a slot range, following paginationToken
async function fetchAllSigs(rpc, address, slotGte, slotLt) {
  const results = [];
  let token;
  for (let page = 0; page < 20; page++) {
    const opts = {
      filters: { status: "succeeded", slot: { gte: slotGte, lt: slotLt } },
      ...(token ? { paginationToken: token } : {}),
    };
    const r = await rpc.sigsPage(address, opts);
    const data = r?.data ?? [];
    for (const entry of data) {
      results.push({
        signature: entry.signature ?? entry,
        slot:      entry.slot ?? 0,
        txIndex:   entry.transactionIndex ?? 0,
      });
    }
    // Phantom token fix (V14 research): skip token if data < limit
    if (data.length < SIG_LIMIT || !r?.paginationToken) break;
    token = r.paginationToken;
  }
  return results;
}

// ─── API tier detection ───────────────────────────────────────────────────────
const _tierCache = { tier: null, expiry: 0 };
const TIER_PROBE_ADDR = "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs";

export async function detectApiTier(apiKey) {
  const now = Date.now();
  if (_tierCache.tier && now < _tierCache.expiry) return _tierCache.tier;
  try {
    const rpc  = makeRpc(apiKey, 1);
    const r    = await rpc.tierProbe(TIER_PROBE_ADDR);
    const tier = r ? "paid" : "free";
    _tierCache.tier   = tier;
    _tierCache.expiry = now + 60_000;
    return tier;
  } catch {
    _tierCache.tier   = "free";
    _tierCache.expiry = now + 60_000;
    return "free";
  }
}

// ─── Free-tier solver (density-routed, from Hybrid BO research) ──────────────
async function solveFree(address, apiKey, mode) {
  const t0      = performance.now();
  const profile = mode === "complete" ? CONFIGS.free_complete : CONFIGS.free_fast;
  const rpc     = makeRpc(apiKey, Math.max(
    profile.sparse.maxConcurrency, profile.medium.maxConcurrency
  ));

  // Standard Solana RPC methods (no paid Helius endpoint needed)
  const sigsForAddr = (addr, limit, before) => rpc.callCount() >= 0 && _fetch(HELIUS_URL(apiKey), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
      params: [addr, { limit, ...(before ? { before } : {}) }],
    }),
  }).then(r => r.json()).then(j => j.result ?? []);

  const getTx = sig => _fetch(HELIUS_URL(apiKey), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }),
  }).then(r => r.json()).then(j => j.result);

  // Phase 0: get first 1000 sigs, classify density
  const page0    = await sigsForAddr(address, 1000);
  const page0Ok  = (page0 ?? []).filter(s => s.err === null);
  const isDense  = (page0 ?? []).length >= 1000;
  const walletType = isDense ? "dense" : page0Ok.length > profile.sparseThreshold ? "medium" : "sparse";
  const cfg = profile[walletType];

  // Collect succeeded sigs up to txTarget
  const succeededSigs = [...page0Ok];
  if (!isDense && succeededSigs.length < cfg.txTarget) {
    let before = (page0 ?? []).at(-1)?.signature;
    for (let pg = 1; pg < 6 && before && succeededSigs.length < cfg.txTarget; pg++) {
      const arr = (await sigsForAddr(address, 1000, before)) ?? [];
      if (!arr.length) break;
      arr.filter(s => s.err === null).forEach(s => succeededSigs.push(s));
      before = arr.at(-1)?.signature;
      if (arr.length < 1000) break;
    }
  }

  const selected = succeededSigs.slice(0, cfg.txTarget);
  const freeSem  = makeSemaphore(cfg.maxConcurrency);
  const rawSamples = [];
  let freeCalls  = 1 + Math.ceil(succeededSigs.length / 1000); // sig fetches

  await Promise.all(selected.map(async entry => {
    const rel = await freeSem();
    freeCalls++;
    try {
      const tx = await getTx(entry.signature);
      if (!tx) return;
      const idx = resolveAccountIndex(tx, address);
      if (idx < 0) return;
      const pre  = tx?.meta?.preBalances?.[idx]  ?? null;
      const post = tx?.meta?.postBalances?.[idx] ?? null;
      if (pre === null || post === null) return;
      rawSamples.push({
        slot: tx.slot ?? 0, txIndex: tx.transactionIndex ?? 0,
        blockTime: tx.blockTime ?? 0,
        signature: tx.transaction?.signatures?.[0] ?? "",
        preLamports: pre, postLamports: post,
      });
    } catch { } finally { rel(); }
  }));

  return buildCurve(address, rawSamples, freeCalls, performance.now() - t0, {
    apiTier: "free", walletType, mode, txFetched: selected.length,
  });
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Fetch SOL balance history for any wallet address.
 *
 * @param {string} address  Solana base58 public key
 * @param {string} apiKey   Helius API key
 * @param {object} [opts]
 * @param {"fast"|"complete"} [opts.mode]   default "fast"
 * @param {"auto"|"paid"|"free"} [opts.tier] default "auto"
 * @returns {Promise<{address, points, stats, routing}>}
 */
export async function fetchUltimate(address, apiKey, opts = {}) {
  const { mode = "fast", tier = "auto" } = opts;
  const detectedTier = tier === "auto" ? await detectApiTier(apiKey) : tier;

  const result = detectedTier === "paid"
    ? await solveUltimate(address, apiKey)
    : await solveFree(address, apiKey, mode);

  return {
    ...result,
    routing: {
      tier:        result.stats.apiTier,
      walletType:  result.stats.walletType,
      mode:        result.stats.mode ?? detectedTier,
      phase:       result.stats.phase,
    },
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const args    = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const flags   = new Set(process.argv.slice(2).filter(a => a.startsWith("--")));
  const address = args[0];
  const apiKey  = args[1] ?? process.env.HELIUS_API_KEY;

  if (!address || !apiKey) {
    console.error(`
  sol_balance_ultimate.mjs — Universal SOL balance history

  Usage: node sol_balance_ultimate.mjs <address> [apiKey] [flags]

  Flags:
    --free       Force free-tier path
    --paid       Force paid-tier path
    --complete   Free-tier: fetch more samples for medium wallet
    --bench      Show detailed performance breakdown
    --compare    Also run V14 for side-by-side comparison

  Phantom wallet: open Phantom → click wallet name → copy address
  Example: node sol_balance_ultimate.mjs 7xKXtg2... 414c80da-...
`);
    process.exit(1);
  }

  const mode = flags.has("--complete") ? "complete" : "fast";
  const tier = flags.has("--free") ? "free" : flags.has("--paid") ? "paid" : "auto";
  const bench   = flags.has("--bench");
  const compare = flags.has("--compare");

  console.log(`\nQuerying: ${address.slice(0, 10)}...${address.slice(-6)}`);
  console.log(`API key:  ${apiKey.slice(0, 8)}...  tier: ${tier}  mode: ${mode}`);

  const t0 = Date.now();
  const r  = await fetchUltimate(address, apiKey, { mode, tier });
  const ms = Date.now() - t0;

  const s = r.stats;
  console.log(`\n${"═".repeat(66)}`);
  console.log(`Tier: ${s.apiTier?.toUpperCase()} · Type: ${s.walletType} · Phase reached: ${s.phase ?? "—"}`);
  console.log(`Calls: ${s.totalRpcCalls}  Wall: ${s.wallTimeMs.toFixed(0)}ms  Samples: ${s.sampleCount}  Gaps: ${s.openGapsRemaining}`);
  if (bench && s.totalSigs) {
    console.log(`Sigs collected: ${s.totalSigs}  Chunks: ${s.chunks}  From Phase0 recent: ${s.coverageFromRecent}`);
  }
  console.log(`${"─".repeat(66)}`);

  if (!r.points.length) {
    console.log("No SOL balance events found in history.");
  } else {
    const fmt = bt => bt ? new Date(bt * 1000).toISOString().slice(0, 10) : "——————";
    console.log(`${"Date".padEnd(12)} ${"Slot".padStart(12)}  ${"Balance SOL".padStart(14)}  Change`);
    console.log("─".repeat(56));
    let prev = null;
    for (const p of r.points) {
      if (p.kind === "flat") continue;
      const sol    = p.lamports / LAMPORTS;
      const delta  = prev !== null
        ? (sol - prev >= 0 ? "+" : "") + (sol - prev).toFixed(6)
        : "opening";
      console.log(`${fmt(p.blockTime).padEnd(12)} ${String(p.slot).padStart(12)}  ${sol.toFixed(6).padStart(14)} SOL  ${delta}`);
      prev = sol;
    }
    console.log("─".repeat(56));
    const open  = r.openingLamports / LAMPORTS;
    const close = r.closingLamports / LAMPORTS;
    console.log(`Opening: ${open.toFixed(6)} SOL  →  Closing: ${close.toFixed(6)} SOL`);
    console.log(`Net:     ${(close - open >= 0 ? "+" : "")}${(close - open).toFixed(6)} SOL`);
  }
  console.log(`${"═".repeat(66)}`);
  console.log(`Total wall time: ${ms}ms`);

  if (compare) {
    console.log("\n── V14 comparison ──────────────────────────────────");
    const { solBalanceOverTime } = await import("./sol_balance_v14.mjs");
    const CFG = { sigPageSize: 1000, maxSigPages: 20, windowTarget: 100,
                  windowSize: 62, maxConcurrency: 13, skipZeroDelta: false };
    const t1  = Date.now();
    const rv  = await solBalanceOverTime(address, apiKey, CFG);
    const msV = Date.now() - t1;
    console.log(`V14: calls=${rv.stats?.totalRpcCalls}  wall=${msV}ms  samples=${rv.stats?.sampleCount}`);
    console.log(`Ultimate: calls=${s.totalRpcCalls}  wall=${ms}ms  samples=${s.sampleCount}`);
    console.log(`Δ calls: ${s.totalRpcCalls - (rv.stats?.totalRpcCalls ?? 0)}  Δ wall: ${ms - msV}ms`);
  }
}
