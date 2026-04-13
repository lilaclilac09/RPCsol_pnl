/**
 * SOL Balance Router v2 — Research-backed universal router.
 *
 * Merges the 5 winning techniques from external repo analysis into the
 * BO-optimal density routing design from V14 / V15 / Hybrid research:
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Technique                    Source              Applied where          │
 * │  ──────────────────────────────────────────────────────────────────────  │
 * │  undici HTTP/1.1 pool (64)    H33ai-postquantum   both paid + free       │
 * │  Phase-0 3-call fan-out       sol-pnl              paid tier             │
 * │  Sig probe → skip Phase 1     fastpnl              paid ≤1000 txs        │
 * │  90-sig chunks (0 pagination) fastpnl              paid Phase 2          │
 * │  Balance continuity oracle    sol-pnl              paid + free           │
 * │  loadedAddresses v0 tx fix    mert-algo            paid + free           │
 * │  Phantom paginationToken fix  V14 research         paid + free           │
 * │  Density routing (sparse/med/dense) Hybrid BO      free tier             │
 * │  BO-optimal free configs      V15/Hybrid (60 tri.) free tier             │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * PAID tier algorithm (3 phases, 2 RTTs for ≤1000 tx wallets):
 *   Phase 0 — 3 parallel calls at t=0:
 *     · first-tx probe  (asc,  limit=1, full)
 *     · last-tx probe   (desc, limit=1, full)
 *     · sig probe       (asc,  limit=1000, sigs) — all sigs if ≤1000 txs
 *   Phase 1 — only for >1000 tx wallets:
 *     · 16 parallel sig-sweep bands across slot span
 *   Phase 2 — full-tx fetch (parallel, 90-sig chunks, 0 pagination):
 *     · ceil(totalSigs / 90) parallel gTFA(full) calls
 *     · 90 ≤ 100 limit → pagination NEVER triggered
 *
 * FREE tier algorithm (density-routed, BO-optimal):
 *   Phase 0 — getSignaturesForAddress(limit=1000) → classify + collect
 *   Classify → sparse / medium / dense
 *   Per-type txTarget + concurrency from Hybrid BO (gate=1.0 at trial 2)
 *   All tx fetches parallel with per-type semaphore
 *
 * Usage:
 *   import { fetchBalanceHistory } from "./sol_balance_router.mjs";
 *   const r = await fetchBalanceHistory(address, apiKey);
 *   // r.points   → [{ slot, lamports, blockTime, kind }]
 *   // r.stats    → { wallTimeMs, totalRpcCalls, sampleCount, apiTier, walletType }
 *   // r.routing  → { tier, walletType, mode, strategy }
 *
 * CLI:
 *   node sol_balance_router.mjs <address> [apiKey] [--free] [--paid] [--complete] [--bench]
 */

import { setGlobalDispatcher, Agent as UndiciAgent, fetch as undiciFetch } from "undici";

// ─── HTTP/1.1 keepalive pool ─────────────────────────────────────────────────
// H33ai-postquantum discovery: HTTP/2 is 6× SLOWER on Helius/Cloudflare.
// Cloudflare's HTTP/2 stream scheduler serialises requests server-side.
// 64 persistent HTTP/1.1 connections with TCP keepalive = true parallelism.
setGlobalDispatcher(new UndiciAgent({
  connections:         64,
  pipelining:          1,
  keepAliveTimeout:    30_000,
  keepAliveMaxTimeout: 60_000,
}));
const _fetch = undiciFetch;

// ─── Constants ───────────────────────────────────────────────────────────────
const HELIUS  = k  => `https://mainnet.helius-rpc.com/?api-key=${k}`;
const SIG_MAX   = 1000; // max sigs per gTFA signatures call
const FULL_MAX  = 100;  // max full txs per gTFA call
const CHUNK     = 90;   // frcd10/fastpnl: 90 ≤ 100 limit → pagination NEVER triggered
// MAX_BANDS is now dynamic (see _calcBands). This cap prevents absurd counts on 1M+ tx wallets.
const BANDS_CAP = 512;  // hard cap: 512 × 1000 sigs = 512k txs per sweep pass
const BANDS_MIN = 2;    // minimum bands even for tiny wallets
const RETRY_BASE = 150;
const MAX_RETRY  = 4;
const SOL = 1_000_000_000;

// ─── BO-optimal configs (locked from research) ───────────────────────────────
export const ROUTING_CONFIGS = {
  // Free tier — Hybrid BO trial 2: sparseThreshold=25, gate=1.0 achieved (avg 1604ms)
  free_fast: {
    sparseThreshold: 25,
    sparse: { txTarget: 11, maxConcurrency: 12 },   // ~1.2s, complete
    medium: { txTarget: 23, maxConcurrency: 19 },   // ~1.8s, partial, gate=1.0
    dense:  { txTarget: 23, maxConcurrency: 19 },   // ~1.8s, partial
  },
  // Free tier — V15 BO trial 7: medium complete via skip=false trick
  free_complete: {
    sparseThreshold: 25,
    sparse: { txTarget: 11, maxConcurrency: 12 },   // ~1.2s, complete
    medium: { txTarget: 31, maxConcurrency: 12 },   // ~3.5s, complete (every sig = valid sample)
    dense:  { txTarget: 31, maxConcurrency: 12 },   // ~6s,   partial (rate-limit ceiling)
  },
};

// ─── Shared infrastructure ───────────────────────────────────────────────────

function _semaphore(n) {
  let active = 0; const q = [];
  return () => new Promise(res => {
    const go = () => { active++; res(() => { active--; q.shift()?.(); }); };
    active < n ? go() : q.push(go);
  });
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _makeRpc(apiKey, concurrency = 48) {
  const url = HELIUS(apiKey);
  const sem = _semaphore(concurrency);
  let calls = 0;

  const post = async body => {
    for (let i = 0; i <= MAX_RETRY; i++) {
      const rel = await sem(); calls++;
      try {
        const res = await _fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const txt = await res.text();
        if (!res.ok) {
          if ((res.status === 429 || res.status >= 500) && i < MAX_RETRY) {
            await _sleep(RETRY_BASE * (2 ** i) + Math.random() * 80); continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const j = JSON.parse(txt);
        if (j?.error) throw new Error(JSON.stringify(j.error));
        return j.result;
      } catch (e) {
        if (/429|503|timed out|ECONNRESET|fetch failed/i.test(String(e?.message)) && i < MAX_RETRY) {
          await _sleep(RETRY_BASE * (2 ** i) + Math.random() * 80); continue;
        }
        throw e;
      } finally { rel(); }
    }
  };

  return {
    count: () => calls,
    // Helius getTransactionsForAddress — signatures mode (1000/page)
    gTFAsigs: (addr, extra = {}) => post({ jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [addr, { transactionDetails: "signatures", sortOrder: "asc",
                       limit: SIG_MAX, filters: { status: "succeeded" }, ...extra }] }),
    // Helius getTransactionsForAddress — full mode (100/page)
    gTFAfull: (addr, extra = {}) => post({ jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [addr, { transactionDetails: "full", sortOrder: "asc",
                       limit: FULL_MAX, filters: { status: "succeeded" },
                       maxSupportedTransactionVersion: 0, ...extra }] }),
    // Standard Solana RPC — getSignaturesForAddress (free tier)
    getSignatures: (addr, limit, before) => post({ jsonrpc: "2.0", id: calls + 1,
      method: "getSignaturesForAddress",
      params: [addr, { limit, ...(before ? { before } : {}) }] }),
    // Standard Solana RPC — getTransaction (free tier)
    getTransaction: sig => post({ jsonrpc: "2.0", id: calls + 1,
      method: "getTransaction",
      params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] }),
  };
}

// ─── Account resolution: v0 versioned tx support (mert-algo fix) ─────────────
// v0 txs use Address Lookup Tables. accountKeys alone is incomplete.
// Must append loadedAddresses.writable + .readonly to find correct index.
function _accountIndex(tx, address) {
  const keys   = (tx?.transaction?.message?.accountKeys ?? [])
                   .map(k => (typeof k === "string" ? k : k?.pubkey));
  const loaded = [
    ...(tx?.meta?.loadedAddresses?.writable ?? []),
    ...(tx?.meta?.loadedAddresses?.readonly ?? []),
  ];
  return [...keys, ...loaded].findIndex(k => k === address);
}

function _extractSample(tx, address) {
  const idx = _accountIndex(tx, address);
  if (idx < 0) return null;
  const pre  = tx?.meta?.preBalances?.[idx]  ?? null;
  const post = tx?.meta?.postBalances?.[idx] ?? null;
  if (pre === null || post === null) return null;
  return {
    slot:         tx.slot         ?? 0,
    txIndex:      tx.transactionIndex ?? 0,
    blockTime:    tx.blockTime    ?? 0,
    signature:    tx.transaction?.signatures?.[0] ?? "",
    preLamports:  pre,
    postLamports: post,
  };
}

// ─── Balance continuity oracle (sol-pnl technique) ───────────────────────────
// If A.post === B.pre, the gap is provably flat. Flag gaps where it isn't.
function _buildCurve(address, rawSamples, rpcCalls, wallMs, meta = {}) {
  // Dedup by signature
  const seen = new Map();
  for (const s of rawSamples) {
    const key = s.signature || `${s.slot}:${s.txIndex}:${s.preLamports}`;
    if (!seen.has(key)) seen.set(key, s);
  }
  const samples = [...seen.values()].sort((a, b) =>
    a.slot !== b.slot ? a.slot - b.slot : (a.txIndex ?? 0) - (b.txIndex ?? 0)
  );

  // Build curve with continuity oracle
  const points = [];
  let openGaps = 0;
  let lastLam = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (lastLam !== null) {
      if (lastLam !== s.preLamports) {
        // Gap is NOT flat — something happened between these two samples
        openGaps++;
        points.push({ slot: s.slot - 1, lamports: lastLam, blockTime: s.blockTime, kind: "flat" });
      }
      // If lastLam === s.preLamports: oracle confirms gap is flat — no extra point needed
    }
    points.push({ slot: s.slot, lamports: s.postLamports, blockTime: s.blockTime, kind: "sample" });
    lastLam = s.postLamports;
  }

  return {
    address, points,
    openingLamports: samples[0]?.preLamports    ?? 0,
    closingLamports: samples.at(-1)?.postLamports ?? 0,
    stats: {
      totalRpcCalls:    rpcCalls,
      wallTimeMs:       wallMs,
      sampleCount:      samples.length,
      openGapsRemaining: openGaps,
      resolvedByContinuity: samples.length - openGaps - 1 < 0 ? 0 : samples.length - openGaps - 1,
      ...meta,
    },
  };
}

// ─── Band sizing formula (frcd10/fastpnl adapted for our 400ms RTT) ──────────
//
// frcd10/fastpnl wall formula (50 RPS, 56ms RTT, 2323 txs → 57 calls):
//   Wall = (calls − 1) × (1000ms / RPS) + RTT
//        = 56 × 20ms + 56ms = 1,176ms  ← matches measurement exactly
//
// Our setup (undici 64 connections, no rate-limit, ~400ms RTT):
//   All calls fire in parallel, limited by pool size (64 connections).
//   Wall ≈ ceil(calls / 64) × RTT
//
// For N total txs:
//   sigBands   = ceil(N / SIG_MAX)          ← Phase 1 calls
//   fullChunks = ceil(N / CHUNK)            ← Phase 2 calls
//   sigRTTs    = ceil(sigBands  / 64)
//   fullRTTs   = ceil(fullChunks / 64)
//   totalTime  ≈ 400ms + (sigRTTs × 400ms) + (fullRTTs × 400ms)
//
//   N=451  : sigBands=1  fullChunks=6   → 2 RTTs ≈ 800ms–1700ms  ✓
//   N=2323 : sigBands=3  fullChunks=26  → 3 RTTs ≈ 1200ms–2000ms
//   N=10k  : sigBands=10 fullChunks=112 → 4 RTTs ≈ 1600ms–2500ms
//   N=50k  : sigBands=50 fullChunks=556 → 12 RTTs ≈ 4800ms (1 pass sig sweep + 9 passes full-tx)
//
// Key: sig sweep always ≤ 1 RTT if N ≤ 64,000 (64 bands × 1000 sigs). Full-tx fetch
// is the bottleneck for large wallets. Only an L0 cache removes that ceiling.

function _calcBands(firstSlot, lastSlot, probeData) {
  // Estimate total tx count from probe density
  const probeLastSlot = probeData.at(-1)?.slot ?? firstSlot;
  const probeSpan     = Math.max(1, probeLastSlot - firstSlot);
  const totalSpan     = Math.max(1, lastSlot - firstSlot + 1);

  // 1000 sigs covered probeSpan slots → project to full span, add 30% safety margin
  const estTotal = Math.ceil(SIG_MAX * (totalSpan / probeSpan) * 1.3);

  // Each band should hold ≤ SIG_MAX * 0.8 = 800 sigs (80% safety factor).
  // This ensures no band overflows even with uneven distribution.
  // Capped at BANDS_CAP to prevent absurd counts on extremely large wallets.
  const numBands = Math.min(BANDS_CAP, Math.max(BANDS_MIN, Math.ceil(estTotal / (SIG_MAX * 0.8))));
  const bandSize = Math.ceil(totalSpan / numBands);

  return { numBands, bandSize, estTotal };
}

// ─── Parallel-safe sig fetcher — recursive bisection on overflow ──────────────
// Replaces the old sequential _fetchAllSigs loop.
// If a slot range returns SIG_MAX sigs (band overflow), bisect into 2 parallel halves.
// Depth cap = 8 levels = can handle 2^8 = 256× overflow per band (256k txs in 1 band slot range).
// At depth 8, falls back to sequential pagination as final resort.
async function _fetchBandSigs(rpc, address, gte, lt, depth = 0) {
  const r    = await rpc.gTFAsigs(address, { filters: { status: "succeeded", slot: { gte, lt } } });
  const data = r?.data ?? [];

  // No overflow: return directly (V14 phantom fix: skip token when data < SIG_MAX)
  if (data.length < SIG_MAX || !r?.paginationToken) {
    return data.map(e => ({ signature: e.signature ?? e, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0 }));
  }

  // Overflow detected. Options:
  if (depth >= 8 || lt - gte <= 1) {
    // Can't subdivide further — follow pagination sequentially (last resort)
    const results = data.map(e => ({ signature: e.signature ?? e, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0 }));
    let token = r.paginationToken;
    for (let pg = 1; pg < 30 && token; pg++) {
      const r2 = await rpc.gTFAsigs(address, { filters: { status: "succeeded", slot: { gte, lt } }, paginationToken: token });
      const d2 = r2?.data ?? [];
      for (const e of d2) results.push({ signature: e.signature ?? e, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0 });
      if (d2.length < SIG_MAX || !r2?.paginationToken) break;
      token = r2.paginationToken;
    }
    return results;
  }

  // Bisect: split this range into 2 parallel halves → true parallelism, no token chaining
  const mid = Math.floor((gte + lt) / 2);
  const [left, right] = await Promise.all([
    _fetchBandSigs(rpc, address, gte, mid, depth + 1),
    _fetchBandSigs(rpc, address, mid, lt,  depth + 1),
  ]);
  return [...left, ...right];
}

// ─── Paid-tier solver ─────────────────────────────────────────────────────────
//
//  Classification (paid tier):
//  ┌──────────────┬──────────────┬──────────────────────────────────────────────┐
//  │ Label        │ Sig count    │ Mechanism                                    │
//  ├──────────────┼──────────────┼──────────────────────────────────────────────┤
//  │ sparse       │ ≤100 txs     │ Phase 0 only — probe sigs < SIG_MAX          │
//  │ medium       │ 101–999 txs  │ Phase 0 only — probe sigs < SIG_MAX          │
//  │ dense        │ 1k–10k txs   │ Phase 0+1+2  — sig sweep ≤1 RTT (≤64 bands) │
//  │ whale        │ >10k txs     │ Phase 0+1+2  — sig sweep 2+ RTTs             │
//  └──────────────┴──────────────┴──────────────────────────────────────────────┘
//
//  Free-tier sparse/medium/dense is different: it's about BO-optimal txTarget
//  and maxConcurrency config per wallet class. threshold=25 came from Hybrid BO.

async function _solvePaid(address, apiKey) {
  const t0  = performance.now();
  const rpc = _makeRpc(apiKey, 48);

  // ── Phase 0: 3 parallel at t=0 ──────────────────────────────────────────────
  // A: first tx (boundary, asc, full)    → firstSlot, opening balance
  // B: last tx  (boundary, desc, full)   → lastSlot
  // C: sig probe (asc, 1000)             → ALL sigs if ≤1000 txs (99% of retail wallets)
  //    fastpnl Trick ②: if probe < SIG_MAX → Phase 1 skipped entirely
  const [ascResult, descResult, sigProbeResult] = await Promise.all([
    rpc.gTFAfull(address, { sortOrder: "asc",  limit: 1 }),
    rpc.gTFAfull(address, { sortOrder: "desc", limit: 1 }),
    rpc.gTFAsigs(address),
  ]);

  const firstTx = ascResult?.data?.[0];
  if (!firstTx) {
    return _buildCurve(address, [], rpc.count(), performance.now() - t0,
      { apiTier: "paid", walletType: "empty", phase: "0" });
  }

  const firstSlot = firstTx.slot;
  const lastSlot  = descResult?.data?.[0]?.slot ?? firstSlot;
  const probeData = sigProbeResult?.data ?? [];
  const probeMore = probeData.length >= SIG_MAX && !!sigProbeResult?.paginationToken;

  // ── Phase 1: sig sweep (only for >SIG_MAX tx wallets) ───────────────────────
  let allSigs;
  if (!probeMore) {
    // ≤1000 txs: all sigs already in hand — Phase 1 costs 0 extra calls
    allSigs = probeData.map(e => ({
      signature: e.signature ?? e, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0,
    }));
  } else {
    // >1000 txs: dynamic band sweep
    // Band count is density-estimated (not fixed). Each band is sized to hold ≤800 sigs.
    // Overflow bands are bisected recursively — NO sequential pagination chains.
    const { numBands, bandSize } = _calcBands(firstSlot, lastSlot, probeData);

    const bandResults = await Promise.all(
      Array.from({ length: numBands }, (_, i) => {
        const gte = firstSlot + i * bandSize;
        const lt  = Math.min(lastSlot + 1, gte + bandSize);
        return _fetchBandSigs(rpc, address, gte, lt);
      })
    );

    // Merge all bands, dedup by signature
    const sigSeen = new Set();
    allSigs = [];
    for (const band of bandResults) {
      for (const e of band) {
        if (!sigSeen.has(e.signature)) { sigSeen.add(e.signature); allSigs.push(e); }
      }
    }
    // Merge Phase 0 probe sigs (may predate band coverage)
    for (const e of probeData) {
      const sig = e.signature ?? e;
      if (!sigSeen.has(sig)) {
        sigSeen.add(sig);
        allSigs.push({ signature: sig, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0 });
      }
    }
  }

  if (allSigs.length === 0) {
    return _buildCurve(address, [], rpc.count(), performance.now() - t0,
      { apiTier: "paid", walletType: "empty", phase: "1" });
  }

  allSigs.sort((a, b) => a.slot !== b.slot ? a.slot - b.slot : a.txIndex - b.txIndex);

  // ── Phase 2: full-tx fetch — 90-sig chunks, all parallel, 0 pagination ──────
  // frcd10/fastpnl Trick ③: 90 ≤ 100 limit → pagination NEVER triggered.
  // All chunks fire simultaneously → single RTT for all full-tx data.
  const chunks = [];
  for (let i = 0; i < allSigs.length; i += CHUNK) chunks.push(allSigs.slice(i, i + CHUNK));

  const fullBatches = await Promise.all(
    chunks.map(chunk => {
      const gte = chunk[0].slot;
      const lt  = chunk.at(-1).slot + 1;
      return rpc.gTFAfull(address, {
        filters: { status: "succeeded", slot: { gte, lt } },
      }).then(r => r?.data ?? []).catch(() => []);
    })
  );

  const samples = [];
  for (const txList of fullBatches) {
    for (const tx of txList) {
      const s = _extractSample(tx, address);
      if (s) samples.push(s);
    }
  }

  // Wallet type based on actual sig count (paid tier — different from free-tier thresholds)
  const walletType = allSigs.length > 10_000 ? "whale"
    : allSigs.length >= SIG_MAX              ? "dense"
    : allSigs.length > 100                   ? "medium"
    :                                          "sparse";

  return _buildCurve(address, samples, rpc.count(), performance.now() - t0, {
    apiTier: "paid", walletType,
    phase:    probeMore ? "0+1+2" : "0+2",
    totalSigs: allSigs.length,
    chunks:    chunks.length,
    bands:     probeMore ? Math.ceil(allSigs.length / SIG_MAX) : 0,
  });
}

// ─── Free-tier solver — density-routed, BO-optimal ───────────────────────────

async function _solveFree(address, apiKey, mode) {
  const t0      = performance.now();
  const profile = mode === "complete" ? ROUTING_CONFIGS.free_complete : ROUTING_CONFIGS.free_fast;
  const rpc     = _makeRpc(apiKey, Math.max(
    profile.sparse.maxConcurrency, profile.medium.maxConcurrency,
  ));

  // Phase 0: getSignaturesForAddress — classify density AND start data collection
  const page0     = (await rpc.getSignatures(address, 1000)) ?? [];
  const page0Succ = page0.filter(s => s.err === null);
  const isDense   = page0.length >= 1000;

  const walletType = isDense                                          ? "dense"
    : page0Succ.length > profile.sparseThreshold                     ? "medium"
    :                                                                   "sparse";

  const cfg      = profile[walletType];
  const fetchSem = _semaphore(cfg.maxConcurrency);

  // Collect enough succeeded sigs to reach txTarget
  const okSigs = [...page0Succ];
  if (okSigs.length < cfg.txTarget) {
    let before = page0.at(-1)?.signature;
    for (let pg = 1; pg < 8 && before && okSigs.length < cfg.txTarget; pg++) {
      const arr = (await rpc.getSignatures(address, 1000, before)) ?? [];
      if (!arr.length) break;
      arr.filter(s => s.err === null).forEach(s => okSigs.push(s));
      before = arr.at(-1)?.signature;
      if (arr.length < 1000) break;
    }
  }

  const selected = okSigs.slice(0, cfg.txTarget);
  const samples  = [];

  // All getTransaction calls parallel (BO-optimal concurrency per wallet type)
  await Promise.all(selected.map(async entry => {
    const rel = await fetchSem();
    try {
      const tx = await rpc.getTransaction(entry.signature);
      if (!tx) return;
      const s = _extractSample(tx, address);
      if (s) samples.push(s);
    } catch { } finally { rel(); }
  }));

  return _buildCurve(address, samples, rpc.count(), performance.now() - t0, {
    apiTier: "free", walletType, mode, txFetched: selected.length,
  });
}

// ─── API tier detection + connection warmup (60s TTL cache) ──────────────────
// H33ai-postquantum: a single warmup call pre-establishes the HTTP/1.1 pool.
// This probe fires anyway for tier detection — it doubles as connection warmup.
// Cold-start penalty: ~300ms TLS handshake, paid once per process.
const _tierCache = { tier: null, expiry: 0, key: null };
const _PROBE_ADDR = "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs";

export async function detectApiTier(apiKey) {
  const now = Date.now();
  if (_tierCache.key === apiKey && _tierCache.tier && now < _tierCache.expiry)
    return _tierCache.tier;
  try {
    const rpc  = _makeRpc(apiKey, 1);
    const r    = await rpc.gTFAsigs(_PROBE_ADDR, { limit: 1 });
    const tier = r ? "paid" : "free";
    Object.assign(_tierCache, { tier, key: apiKey, expiry: now + 60_000 });
    return tier;
  } catch {
    Object.assign(_tierCache, { tier: "free", key: apiKey, expiry: now + 60_000 });
    return "free";
  }
}

/**
 * Pre-warm the HTTP/1.1 connection pool for a given API key.
 * Call this once at startup before the first fetchBalanceHistory.
 * Eliminates the ~300ms cold-start TLS penalty from the first real query.
 */
export async function warmup(apiKey) {
  return detectApiTier(apiKey); // tier probe doubles as warmup
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Fetch SOL balance history for any wallet address.
 *
 * @param {string}  address          Solana base58 public key (your Phantom address)
 * @param {string}  apiKey           Helius API key
 * @param {object}  [opts]
 * @param {"fast"|"complete"} [opts.mode]    default "fast"
 * @param {"auto"|"paid"|"free"} [opts.tier] default "auto" (probes once, caches 60s)
 * @returns {Promise<{address, points, openingLamports, closingLamports, stats, routing}>}
 */
export async function fetchBalanceHistory(address, apiKey, opts = {}) {
  const { mode = "fast", tier = "auto" } = opts;
  const detectedTier = tier === "auto" ? await detectApiTier(apiKey) : tier;

  const result = detectedTier === "paid"
    ? await _solvePaid(address, apiKey)
    : await _solveFree(address, apiKey, mode);

  const wt  = result.stats.walletType;
  const cfg = detectedTier === "paid" ? { phase0: true, chunks: result.stats.chunks }
    : mode === "complete" ? ROUTING_CONFIGS.free_complete[wt]
    : ROUTING_CONFIGS.free_fast[wt];

  return { ...result, routing: { tier: detectedTier, walletType: wt, mode, strategy: cfg } };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const args  = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const flags = new Set(process.argv.slice(2).filter(a => a.startsWith("--")));
  const [address, apiKey = process.env.HELIUS_API_KEY] = args;

  if (!address || !apiKey) {
    console.error(`
  SOL Balance Router v2 — query any wallet's SOL balance history

  Usage: node sol_balance_router.mjs <address> [apiKey] [flags]

  Flags:
    --free       force free-tier path
    --paid       force paid-tier path
    --complete   free-tier: fetch more samples for medium wallet (~3.5s, fully complete)
    --bench      show per-wallet timing breakdown

  Your Phantom wallet address = the public key in the Phantom app.
  Paid key example:  node sol_balance_router.mjs 7xKXtg2... 414c80da-...
  Free key example:  node sol_balance_router.mjs 7xKXtg2... <key> --free
`);
    process.exit(1);
  }

  const mode  = flags.has("--complete") ? "complete" : "fast";
  const tier  = flags.has("--free") ? "free" : flags.has("--paid") ? "paid" : "auto";
  const bench = flags.has("--bench");

  console.log(`\nQuerying ${address.slice(0, 10)}...${address.slice(-6)}`);
  console.log(`Key: ${apiKey.slice(0, 8)}...  tier: ${tier}  mode: ${mode}`);

  const t0 = Date.now();
  const r  = await fetchBalanceHistory(address, apiKey, { mode, tier });
  const ms = Date.now() - t0;
  const s  = r.stats;

  const gate  = ms >= 3000 ? 0.05 : ms >= 2000 ? 0.60 : 1.0;
  const score = s.sampleCount > 0 ? (1000 / ms) * gate : 0;

  console.log(`\n${"═".repeat(64)}`);
  console.log(`Tier: ${s.apiTier?.toUpperCase()} · Type: ${s.walletType} · Phase: ${s.phase ?? "—"}`);
  console.log(`Calls: ${s.totalRpcCalls}  Wall: ${ms}ms  Samples: ${s.sampleCount}  Gate: ${gate}  Score: ${score.toFixed(4)}`);
  if (bench) {
    console.log(`Sigs: ${s.totalSigs ?? "—"}  Chunks: ${s.chunks ?? "—"}  Gaps: ${s.openGapsRemaining}`);
  }
  console.log(`${"─".repeat(64)}`);

  if (!r.points.length) {
    console.log("No SOL balance events found.");
  } else {
    const fmt = bt => bt ? new Date(bt * 1000).toISOString().slice(0, 10) : "——————————";
    console.log(`${"Date".padEnd(12)} ${"Slot".padStart(12)}  ${"SOL Balance".padStart(14)}  Change`);
    console.log("─".repeat(58));
    let prev = null;
    for (const p of r.points) {
      if (p.kind === "flat") continue;
      const sol   = p.lamports / SOL;
      const delta = prev !== null
        ? (sol - prev >= 0 ? "+" : "") + (sol - prev).toFixed(6)
        : "opening";
      console.log(`${fmt(p.blockTime).padEnd(12)} ${String(p.slot).padStart(12)}  ${sol.toFixed(6).padStart(14)} SOL  ${delta}`);
      prev = sol;
    }
    console.log("─".repeat(58));
    const open  = r.openingLamports / SOL;
    const close = r.closingLamports / SOL;
    console.log(`Opening: ${open.toFixed(6)} SOL  →  Closing: ${close.toFixed(6)} SOL`);
    console.log(`Net:     ${(close - open >= 0 ? "+" : "")}${(close - open).toFixed(6)} SOL`);
  }
  console.log(`${"═".repeat(64)}`);
  console.log(`Total: ${ms}ms`);
}
