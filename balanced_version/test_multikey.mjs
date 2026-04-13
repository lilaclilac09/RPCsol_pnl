/**
 * test_multikey.mjs — Multi-key distributed SOL balance fetcher
 *
 * Splits band sweep (Phase 1) and full-tx fetch (Phase 2) across N API keys
 * in round-robin, like distributing compute across GPUs.
 * Each key has its own undici pool — throughput scales linearly with key count.
 *
 * Usage:
 *   import { fetchBalanceHistoryMultiKey } from "./test_multikey.mjs";
 *   const result = await fetchBalanceHistoryMultiKey(address, [key1, key2, key3]);
 *
 * CLI:
 *   node test_multikey.mjs <address> <key1> <key2> [key3...]
 */

import { setGlobalDispatcher, Agent as UndiciAgent, fetch as undiciFetch } from "undici";

setGlobalDispatcher(new UndiciAgent({
  connections:         64,
  pipelining:          1,
  keepAliveTimeout:    30_000,
  keepAliveMaxTimeout: 60_000,
}));

const SIG_MAX  = 1000;
const CHUNK    = 90;
const FULL_MAX = 100;
const SOL      = 1_000_000_000;

// ── Per-key RPC pool ──────────────────────────────────────────────────────────
// Each key gets its own semaphore + call counter.
// Concurrency per key = 16 (conservative — avoids hitting key-level rate limits).
// Total effective concurrency = 16 × N keys.

function _semaphore(n) {
  let active = 0; const q = [];
  return () => new Promise(res => {
    const go = () => { active++; res(() => { active--; q.shift()?.(); }); };
    active < n ? go() : q.push(go);
  });
}

function _makePool(apiKey, concurrency = 16) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const sem  = _semaphore(concurrency);
  let calls  = 0;

  const post = async body => {
    for (let i = 0; i <= 4; i++) {
      const rel = await sem(); calls++;
      try {
        const res = await undiciFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const txt = await res.text();
        if (!res.ok) {
          if ((res.status === 429 || res.status >= 500) && i < 4) {
            await new Promise(r => setTimeout(r, 150 * (2 ** i) + Math.random() * 80));
            continue;
          }
          throw new Error(`HTTP ${res.status} on key ${apiKey.slice(0,8)}`);
        }
        const j = JSON.parse(txt);
        if (j?.error) throw new Error(JSON.stringify(j.error));
        return j.result;
      } catch (e) {
        if (/429|503|timed out|ECONNRESET/i.test(String(e?.message)) && i < 4) {
          await new Promise(r => setTimeout(r, 150 * (2 ** i) + Math.random() * 80));
          continue;
        }
        throw e;
      } finally { rel(); }
    }
  };

  return {
    count: () => calls,
    key:   apiKey.slice(0, 8),
    gTFAsigs: (addr, extra = {}) => post({ jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [addr, { transactionDetails: "signatures", sortOrder: "asc",
                       limit: SIG_MAX, filters: { status: "succeeded" }, ...extra }] }),
    gTFAfull: (addr, extra = {}) => post({ jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [addr, { transactionDetails: "full", sortOrder: "asc",
                       limit: FULL_MAX, filters: { status: "succeeded" },
                       maxSupportedTransactionVersion: 0, ...extra }] }),
  };
}

// ── Key router — round-robin assignment ──────────────────────────────────────
// Assigns each band/chunk index to a key by index % N.
// Each key handles its slice independently — no coordination, no shared state.

function _assignToKey(pools, index) {
  return pools[index % pools.length];
}

// ── Account index — v0 loadedAddresses support ───────────────────────────────
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

// ── Band sig fetcher — recursive bisect on overflow ──────────────────────────
async function _fetchBandSigs(pool, address, gte, lt, depth = 0) {
  const r    = await pool.gTFAsigs(address, { filters: { status: "succeeded", slot: { gte, lt } } });
  const data = r?.data ?? [];

  if (data.length < SIG_MAX || !r?.paginationToken) {
    return data.map(e => ({ signature: e.signature ?? e, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0 }));
  }

  if (depth >= 8 || lt - gte <= 1) {
    // Sequential fallback — last resort
    const results = data.map(e => ({ signature: e.signature ?? e, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0 }));
    let token = r.paginationToken;
    for (let pg = 1; pg < 30 && token; pg++) {
      const r2 = await pool.gTFAsigs(address, { filters: { status: "succeeded", slot: { gte, lt } }, paginationToken: token });
      const d2 = r2?.data ?? [];
      for (const e of d2) results.push({ signature: e.signature ?? e, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0 });
      if (d2.length < SIG_MAX || !r2?.paginationToken) break;
      token = r2.paginationToken;
    }
    return results;
  }

  // Bisect — same pool handles both halves (pool already assigned by caller)
  const mid = Math.floor((gte + lt) / 2);
  const [left, right] = await Promise.all([
    _fetchBandSigs(pool, address, gte, mid, depth + 1),
    _fetchBandSigs(pool, address, mid, lt,  depth + 1),
  ]);
  return [...left, ...right];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch SOL balance history using multiple API keys in parallel.
 * Each key handles a round-robin slice of bands (Phase 1) and chunks (Phase 2).
 *
 * @param {string}   address   Solana wallet address
 * @param {string[]} apiKeys   Array of Helius API keys (all Developer plan)
 * @returns {Promise<{points, stats}>}
 */
export async function fetchBalanceHistoryMultiKey(address, apiKeys) {
  if (!apiKeys?.length) throw new Error("Need at least one API key");
  const t0    = performance.now();
  const pools = apiKeys.map(k => _makePool(k, 16));

  // ── Phase 0: 3 parallel calls using key[0] ───────────────────────────────
  const p0 = pools[0];
  const [ascResult, descResult, sigProbeResult] = await Promise.all([
    p0.gTFAfull(address, { sortOrder: "asc",  limit: 1 }),
    p0.gTFAfull(address, { sortOrder: "desc", limit: 1 }),
    p0.gTFAsigs(address),
  ]);

  const firstTx   = ascResult?.data?.[0];
  if (!firstTx) return { points: [], stats: { wallTimeMs: Math.round(performance.now() - t0), totalRpcCalls: 3, sampleCount: 0 } };

  const firstSlot = firstTx.slot;
  const lastSlot  = descResult?.data?.[0]?.slot ?? firstSlot;
  const probeData = sigProbeResult?.data ?? [];
  const probeMore = probeData.length >= SIG_MAX && !!sigProbeResult?.paginationToken;

  // ── Phase 1: multi-key band sweep ────────────────────────────────────────
  let allSigs;

  if (!probeMore) {
    // ≤1000 txs — probe has everything, Phase 1 free
    allSigs = probeData.map(e => ({
      signature: e.signature ?? e, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0,
    }));
  } else {
    // Density-estimate band count
    const probeLastSlot = probeData.at(-1)?.slot ?? firstSlot;
    const probeSpan     = Math.max(1, probeLastSlot - firstSlot);
    const totalSpan     = Math.max(1, lastSlot - firstSlot + 1);
    const estTotal      = Math.ceil(SIG_MAX * (totalSpan / probeSpan) * 1.3);
    const numBands      = Math.min(512, Math.max(2, Math.ceil(estTotal / 800)));
    const bandSize      = Math.ceil(totalSpan / numBands);

    console.log(`  Phase 1: ${numBands} bands across ${pools.length} keys (${Math.ceil(numBands/pools.length)} bands/key avg)`);

    // Each band assigned to key by round-robin
    const bandResults = await Promise.all(
      Array.from({ length: numBands }, (_, i) => {
        const gte  = firstSlot + i * bandSize;
        const lt   = Math.min(lastSlot + 1, gte + bandSize);
        const pool = _assignToKey(pools, i);  // round-robin key assignment
        return _fetchBandSigs(pool, address, gte, lt);
      })
    );

    const sigSeen = new Set();
    allSigs = [];
    for (const band of bandResults) {
      for (const e of band) {
        if (!sigSeen.has(e.signature)) { sigSeen.add(e.signature); allSigs.push(e); }
      }
    }
    for (const e of probeData) {
      const sig = e.signature ?? e;
      if (!sigSeen.has(sig)) {
        sigSeen.add(sig);
        allSigs.push({ signature: sig, slot: e.slot ?? 0, txIndex: e.transactionIndex ?? 0 });
      }
    }
  }

  if (!allSigs.length) return { points: [], stats: { wallTimeMs: Math.round(performance.now() - t0), totalRpcCalls: _totalCalls(pools), sampleCount: 0 } };

  allSigs.sort((a, b) => a.slot !== b.slot ? a.slot - b.slot : a.txIndex - b.txIndex);

  // ── Phase 2: multi-key full-tx fetch ────────────────────────────────────
  const chunks = [];
  for (let i = 0; i < allSigs.length; i += CHUNK) chunks.push(allSigs.slice(i, i + CHUNK));

  console.log(`  Phase 2: ${chunks.length} chunks across ${pools.length} keys (${Math.ceil(chunks.length/pools.length)} chunks/key avg)`);

  const fullBatches = await Promise.all(
    chunks.map((chunk, i) => {
      const pool = _assignToKey(pools, i);  // round-robin key assignment
      const gte  = chunk[0].slot;
      const lt   = chunk.at(-1).slot + 1;
      return pool.gTFAfull(address, {
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

  // Dedup + sort
  const seen = new Map();
  for (const s of samples) {
    const key = s.signature || `${s.slot}:${s.txIndex}`;
    if (!seen.has(key)) seen.set(key, s);
  }
  const sorted = [...seen.values()].sort((a, b) =>
    a.slot !== b.slot ? a.slot - b.slot : (a.txIndex ?? 0) - (b.txIndex ?? 0)
  );

  const points = sorted.map(s => ({
    slot: s.slot, lamports: s.postLamports, blockTime: s.blockTime,
    kind: s.postLamports > s.preLamports ? "credit" : "debit",
  }));

  const wallMs     = Math.round(performance.now() - t0);
  const totalCalls = _totalCalls(pools);
  const walletType = allSigs.length > 10_000 ? "whale"
    : allSigs.length >= SIG_MAX              ? "dense"
    : allSigs.length > 100                   ? "medium"
    :                                          "sparse";

  return {
    points,
    stats: {
      wallTimeMs:    wallMs,
      totalRpcCalls: totalCalls,
      sampleCount:   sorted.length,
      totalSigs:     allSigs.length,
      chunks:        chunks.length,
      walletType,
      keysUsed:      pools.length,
      callsPerKey:   pools.map(p => ({ key: p.key, calls: p.count() })),
    },
  };
}

function _totalCalls(pools) {
  return pools.reduce((sum, p) => sum + p.count(), 0);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const [address, ...apiKeys] = args;

  if (!address || !apiKeys.length) {
    console.error(`
  Usage: node test_multikey.mjs <address> <key1> <key2> [key3...]

  Distributes band sweep and chunk fetch across all provided keys in round-robin.
  Each key needs Developer plan access (getTransactionsForAddress).

  Example (3 keys):
    node test_multikey.mjs 59tGCiHi...1P8n key1 key2 key3
`);
    process.exit(1);
  }

  console.log(`\nQuerying ${address.slice(0,10)}...${address.slice(-6)}`);
  console.log(`Keys: ${apiKeys.length} (${apiKeys.map(k => k.slice(0,8)).join(", ")})`);

  const t0 = Date.now();
  const r  = await fetchBalanceHistoryMultiKey(address, apiKeys);
  const ms = Date.now() - t0;
  const s  = r.stats;

  const gate  = ms >= 3000 ? 0.05 : ms >= 2000 ? 0.60 : 1.0;
  const score = s.sampleCount > 0 ? (1000 / ms) * gate : 0;

  console.log(`\n${"═".repeat(64)}`);
  console.log(`Type: ${s.walletType} · Keys: ${s.keysUsed} · Calls: ${s.totalRpcCalls} · Sigs: ${s.totalSigs ?? "—"}`);
  console.log(`Wall: ${ms}ms · Samples: ${s.sampleCount} · Gate: ${gate} · Score: ${score.toFixed(4)}`);
  console.log(`Calls per key: ${s.callsPerKey?.map(k => `${k.key}…=${k.calls}`).join("  ")}`);
  console.log(`${"─".repeat(64)}`);

  if (r.points.length) {
    const fmt = bt => bt ? new Date(bt * 1000).toISOString().slice(0,10) : "——————————";
    console.log(`${"Date".padEnd(12)} ${"Slot".padStart(12)}  ${"SOL".padStart(14)}  Change`);
    console.log("─".repeat(58));
    let prev = null;
    for (const p of r.points) {
      const sol   = p.lamports / SOL;
      const delta = prev !== null ? (sol - prev >= 0 ? "+" : "") + (sol - prev).toFixed(6) : "opening";
      console.log(`${fmt(p.blockTime).padEnd(12)} ${String(p.slot).padStart(12)}  ${sol.toFixed(6).padStart(14)} SOL  ${delta}`);
      prev = sol;
    }
    console.log("─".repeat(58));
  } else {
    console.log("No SOL balance events found.");
  }

  console.log(`${"═".repeat(64)}`);
  console.log(`Total: ${ms}ms`);
}
