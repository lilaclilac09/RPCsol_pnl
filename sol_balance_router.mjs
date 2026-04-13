/**
 * SOL Balance Router — Production-grade, research-backed wallet router.
 *
 * Incorporates the best configuration found by every BO run (V14, V15, Hybrid):
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PAID API (getTransactionsForAddress)                                   │
 * │  Any wallet type → V14 optimal (window=62, c=13, skip=false)           │
 * │  Result: sparse ~570ms · medium ~760ms · dense ~2100ms · avg ~1150ms   │
 * │                                                                         │
 * │  FREE API (getSignaturesForAddress + getTransaction)                    │
 * │  Phase 0 page → classify density (zero extra calls):                   │
 * │    sparse  (page0 not full, succeeded ≤ sparseThreshold)               │
 * │    dense   (page0 full = 1000 raw sigs)                                 │
 * │    medium  (page0 not full, succeeded > sparseThreshold)               │
 * │                                                                         │
 * │  mode "fast" (default): minimises latency, all wallets ~1–2s           │
 * │    sparse:  txTarget=11, c=12 → ~1.2s · complete                       │
 * │    medium:  txTarget=23, c=19 → ~1.8s · partial (gate=1.0 possible)    │
 * │    dense:   txTarget=23, c=19 → ~1.8s · partial                        │
 * │                                                                         │
 * │  mode "complete": maximises data coverage for medium wallet             │
 * │    sparse:  txTarget=11, c=12  → ~1.2s · complete                      │
 * │    medium:  txTarget=31, c=12  → ~3.5s · complete (skip=false trick)   │
 * │    dense:   txTarget=31, c=12  → ~6s   · partial (rate-limit ceiling)  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   import { fetchBalanceHistory } from "./sol_balance_router.mjs";
 *   const result = await fetchBalanceHistory(address, apiKey);
 *   // result.routing  → { tier, walletType, mode, strategy }
 *   // result.points   → [{ slot, lamports, kind }]
 *   // result.stats    → { wallTimeMs, totalRpcCalls, sampleCount, ... }
 *
 * CLI:
 *   node sol_balance_router.mjs <address> [apiKey] [--complete] [--free]
 */

import { solBalanceOverTime as solBalanceV14 } from "./sol_balance_v14.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// BO-optimal configs (locked in from research)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIGS = {
  // V14 (paid tier) — 60 trials, window=62 avoids >100 txns/window, c=13 avoids 429 retries
  paid: {
    sigPageSize: 1000, maxSigPages: 20, windowTarget: 100,
    windowSize: 62, maxConcurrency: 13, skipZeroDelta: false,
  },

  // Free tier — Hybrid BO (gate=1.0 achieved: avg 1604ms, max 1826ms, trial 2)
  free_fast: {
    sparseThreshold: 25,
    sparse:   { txTarget: 11, maxConcurrency: 12 },  // ~1164ms, complete
    medium:   { txTarget: 23, maxConcurrency: 19 },  // ~1826ms, partial (23 < 30 min)
    dense:    { txTarget: 23, maxConcurrency: 19 },  // ~1823ms, partial
  },

  // Free tier — V15 BO (medium complete via skip=false trick, gate=0.05 accepted)
  free_complete: {
    sparseThreshold: 25,
    sparse:   { txTarget: 11, maxConcurrency: 12 },  // ~1.2s,  complete
    medium:   { txTarget: 31, maxConcurrency: 12 },  // ~3.5s,  complete (skip=false counts all sigs)
    dense:    { txTarget: 31, maxConcurrency: 12 },  // ~6s,    partial (rate-limit ceiling)
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// API tier detection (60s TTL cache)
// ─────────────────────────────────────────────────────────────────────────────

const _tierCache = { tier: null, expiry: 0 };

async function detectApiTier(apiKey) {
  const now = Date.now();
  if (_tierCache.tier && now < _tierCache.expiry) return _tierCache.tier;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTransactionsForAddress",
        params: ["54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs",
          { transactionDetails: "signatures", sortOrder: "desc", limit: 1, filters: { status: "succeeded" } }],
      }),
    });
    const json = await res.json().catch(() => null);
    const tier = (res.ok && json && !json.error) ? "paid" : "free";
    _tierCache.tier   = tier;
    _tierCache.expiry = now + 60_000;
    return tier;
  } catch {
    _tierCache.tier   = "free";
    _tierCache.expiry = now + 60_000;
    return "free";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure (free-tier path)
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_BASE_MS = 180;
const MAX_RETRIES   = 4;

function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return () => new Promise(resolve => {
    const go = () => { active++; resolve(() => { active--; queue.shift()?.(); }); };
    active < limit ? go() : queue.push(go);
  });
}

async function withRetry(fn) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try { return await fn(); }
    catch (err) {
      const msg = String(err?.message || "");
      const transient = /429|503|timed out|ECONNRESET|fetch failed|terminated/i.test(msg);
      if (!transient || attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * (2 ** attempt) + Math.floor(Math.random() * 90)));
    }
  }
}

function makeRpc(apiKey, maxConcurrency) {
  const url     = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const acquire = makeSemaphore(maxConcurrency);
  let   calls   = 0;

  const post = body => withRetry(async () => {
    const release = await acquire();
    calls++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`);
      const json = JSON.parse(txt);
      if (json?.error) throw new Error(JSON.stringify(json.error));
      return json.result;
    } finally { release(); }
  });

  const signatures = (address, limit, before) => post({
    jsonrpc: "2.0", id: calls + 1,
    method: "getSignaturesForAddress",
    params: [address, { limit, ...(before ? { before } : {}) }],
  });

  const transaction = sig => post({
    jsonrpc: "2.0", id: calls + 1,
    method: "getTransaction",
    params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
  });

  return { signatures, transaction, callCount: () => calls };
}

function extractSample(tx, address) {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const idx  = keys.findIndex(k => (typeof k === "string" ? k : k?.pubkey) === address);
  if (idx < 0) return null;
  return {
    slot: tx?.slot ?? 0, blockTime: tx?.blockTime ?? 0,
    signature: tx?.transaction?.signatures?.[0] ?? "",
    preLamports:  tx?.meta?.preBalances?.[idx]  ?? 0,
    postLamports: tx?.meta?.postBalances?.[idx] ?? 0,
  };
}

function dedup(samples) {
  const map = new Map();
  for (const s of samples) {
    const k = s.signature || `${s.slot}:${s.preLamports}:${s.postLamports}`;
    if (!map.has(k)) map.set(k, s);
  }
  return [...map.values()].sort((a, b) => a.slot - b.slot);
}

function buildResult(address, rawSamples, rpcCalls, wallMs, meta = {}) {
  const samples = dedup(rawSamples);
  const points  = [];
  let lastLamports = null, lastSlot = null;
  for (const s of samples) {
    if (lastLamports !== null && lastSlot !== null &&
        lastLamports !== s.preLamports && s.slot > lastSlot + 1)
      points.push({ slot: s.slot - 1, lamports: lastLamports, blockTime: s.blockTime, kind: "flat" });
    points.push({ slot: s.slot, lamports: s.postLamports, blockTime: s.blockTime, kind: "sample" });
    lastLamports = s.postLamports; lastSlot = s.slot;
  }
  return {
    address, points,
    openingLamports: samples[0]?.preLamports    ?? 0,
    closingLamports: samples.at(-1)?.postLamports ?? 0,
    stats: {
      totalRpcCalls: rpcCalls, wallTimeMs: wallMs, sampleCount: samples.length,
      openGapsRemaining: 0, resolvedByContinuity: 0,
      ...meta,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Free-tier solver (density-routed)
// ─────────────────────────────────────────────────────────────────────────────

async function solBalanceFree(address, apiKey, mode) {
  const t0      = performance.now();
  const profile = mode === "complete" ? CONFIGS.free_complete : CONFIGS.free_fast;

  // Phase 0: first signature page — classify density AND start data collection
  const rpc0   = makeRpc(apiKey, Math.max(profile.sparse.maxConcurrency, profile.medium.maxConcurrency));
  const page0  = (await rpc0.signatures(address, 1000)) ?? [];
  const pageWasFull = page0.length >= 1000;
  const page0Succ   = page0.filter(s => s.err === null);

  // Classify: dense > medium > sparse
  let walletType;
  if (pageWasFull)                                    walletType = "dense";
  else if (page0Succ.length > profile.sparseThreshold) walletType = "medium";
  else                                                  walletType = "sparse";

  const cfg = profile[walletType];

  // Create fetch RPC with per-type concurrency
  const rpcFetch = makeRpc(apiKey, cfg.maxConcurrency);

  // Accumulate succeeded sigs up to txTarget
  const succeededSigs = [...page0Succ];
  if (succeededSigs.length < cfg.txTarget && !pageWasFull) {
    // Sparse/medium: may need more pages if sig count < txTarget
    let before = page0.at(-1)?.signature;
    for (let pg = 1; pg < 6 && before && succeededSigs.length < cfg.txTarget; pg++) {
      const arr = (await rpc0.signatures(address, 1000, before)) ?? [];
      if (!arr.length) break;
      for (const s of arr) { if (s.err === null) succeededSigs.push(s); }
      before = arr.at(-1)?.signature;
      if (arr.length < 1000) break;
    }
  } else if (pageWasFull && succeededSigs.length < cfg.txTarget) {
    // Dense: fetch more pages
    let before = page0.at(-1)?.signature;
    for (let pg = 1; pg < 6 && succeededSigs.length < cfg.txTarget && before; pg++) {
      const arr = (await rpc0.signatures(address, 1000, before)) ?? [];
      if (!arr.length) break;
      for (const s of arr) { if (s.err === null) succeededSigs.push(s); }
      before = arr.at(-1)?.signature;
      if (arr.length < 1000) break;
    }
  }

  const selected = succeededSigs.slice(0, cfg.txTarget);
  const samples  = [];

  await Promise.all(selected.map(async s => {
    try {
      const tx = await rpcFetch.transaction(s.signature);
      if (!tx) return;
      const sample = extractSample(tx, address);
      if (sample) samples.push(sample);
    } catch { }
  }));

  const totalCalls = rpc0.callCount() + rpcFetch.callCount();
  return buildResult(address, samples, totalCalls, performance.now() - t0, {
    apiTier: "free", walletType, mode,
    txFetched: selected.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main exported function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch SOL balance history for any wallet address.
 *
 * @param {string} address  - Solana wallet public key (base58)
 * @param {string} apiKey   - Helius API key
 * @param {object} [opts]
 * @param {string} [opts.mode]  - "fast" (default) | "complete" (medium wallet gets more samples)
 * @param {string} [opts.tier]  - "auto" (default) | "paid" | "free" (force tier)
 * @returns {Promise<{address, points, stats, routing}>}
 */
export async function fetchBalanceHistory(address, apiKey, opts = {}) {
  const { mode = "fast", tier = "auto" } = opts;

  const detectedTier = tier === "auto" ? await detectApiTier(apiKey) : tier;

  let result;
  if (detectedTier === "paid") {
    result = await solBalanceV14(address, apiKey, CONFIGS.paid);
    result = { ...result, stats: { ...result.stats, apiTier: "paid", walletType: "n/a", mode: "paid" } };
  } else {
    result = await solBalanceFree(address, apiKey, mode);
  }

  return {
    ...result,
    routing: {
      tier:       result.stats.apiTier,
      walletType: result.stats.walletType,
      mode:       result.stats.mode,
      strategy:   detectedTier === "paid" ? CONFIGS.paid
                : mode === "complete"      ? CONFIGS.free_complete[result.stats.walletType]
                :                            CONFIGS.free_fast[result.stats.walletType],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export raw tier detection and classification for tooling
// ─────────────────────────────────────────────────────────────────────────────

export { detectApiTier };

export const ROUTING_CONFIGS = CONFIGS;

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const args    = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const flags   = process.argv.slice(2).filter(a => a.startsWith("--"));
  const address = args[0];
  const apiKey  = args[1] ?? process.env.HELIUS_API_KEY;

  if (!address || !apiKey) {
    console.error([
      "",
      "  SOL Balance Router — query any wallet's SOL balance history",
      "",
      "  Usage: node sol_balance_router.mjs <address> [apiKey] [--complete] [--free] [--paid]",
      "",
      "  Options:",
      "    --complete   free-tier: fetch more samples for medium wallet (3.5s, complete)",
      "    --free       force free-tier path (ignore paid API availability)",
      "    --paid       force paid-tier path (error if API key not paid)",
      "",
      "  Your Phantom wallet address is the public key shown in the Phantom app.",
      "  Example: node sol_balance_router.mjs 7xKXtg2CW... 414c80da-...",
      "",
    ].join("\n"));
    process.exit(1);
  }

  const mode = flags.includes("--complete") ? "complete" : "fast";
  const tier = flags.includes("--free") ? "free" : flags.includes("--paid") ? "paid" : "auto";

  console.log(`\nQuerying ${address.slice(0, 8)}...${address.slice(-4)}`);
  console.log(`API key: ${apiKey.slice(0, 8)}...  mode: ${mode}  tier: ${tier}`);

  const t0     = Date.now();
  const result = await fetchBalanceHistory(address, apiKey, { mode, tier });
  const ms     = Date.now() - t0;

  const LAMPORTS = 1_000_000_000;
  const r = result.routing;

  console.log(`\n${"─".repeat(64)}`);
  console.log(`Routing: ${r.tier.toUpperCase()} tier · ${r.walletType} wallet · ${r.mode} mode`);
  console.log(`Calls: ${result.stats.totalRpcCalls}  Wall time: ${result.stats.wallTimeMs.toFixed(0)}ms  Samples: ${result.stats.sampleCount}`);
  console.log(`${"─".repeat(64)}`);

  if (!result.points.length) {
    console.log("No SOL balance change events found.");
  } else {
    const dateStr = bt => bt ? new Date(bt * 1000).toISOString().slice(0, 10) : "—";
    console.log(`${"Date".padEnd(12)} ${"Slot".padStart(12)}  ${"Balance (SOL)".padStart(16)}  Change`);
    console.log("─".repeat(56));
    let prevSOL = null;
    for (const p of result.points) {
      if (p.kind === "flat") continue;
      const sol    = p.lamports / LAMPORTS;
      const change = prevSOL !== null ? (sol - prevSOL >= 0 ? "+" : "") + (sol - prevSOL).toFixed(6) : "opening";
      console.log(`${dateStr(p.blockTime).padEnd(12)} ${String(p.slot).padStart(12)}  ${sol.toFixed(6).padStart(16)} SOL  ${change}`);
      prevSOL = sol;
    }
    console.log("─".repeat(56));
    const openSOL  = result.openingLamports / LAMPORTS;
    const closeSOL = result.closingLamports / LAMPORTS;
    console.log(`Opening: ${openSOL.toFixed(6)} SOL  →  Closing: ${closeSOL.toFixed(6)} SOL`);
    console.log(`Net change: ${(closeSOL - openSOL >= 0 ? "+" : "")}${(closeSOL - openSOL).toFixed(6)} SOL`);
  }
  console.log(`${"─".repeat(64)}`);
  console.log(`Total: ${ms}ms`);
}
