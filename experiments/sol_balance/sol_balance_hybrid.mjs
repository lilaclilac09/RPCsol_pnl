/**
 * SOL Balance Hybrid — Density-aware routing with API tier detection.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  detectApiTier()  →  "paid" | "free"  (60s TTL cache)          │
 * │                                                                 │
 * │  paid  → delegate to sol_balance_v14.mjs (phantom-token fix)   │
 * │  free  → Phase 0 getSignaturesForAddress → classify density     │
 * │           sparse  (count ≤ sparseThreshold, no next page)       │
 * │           medium  (fits in 1 page, count > sparseThreshold)     │
 * │           dense   (first page full → paginated)                 │
 * │           → route to per-type txTarget/concurrency params       │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Classification is zero-cost: uses the Phase 0 signature page that
 * getSignaturesForAddress would fetch anyway, without any extra calls.
 *
 * Free-tier per-type defaults (tuned by BO, see research_hybrid.mjs):
 *   sparse:      txTarget=8,  c=6,  skip=false → ~1.5-2s  (few sigs)
 *   medium:      txTarget=31, c=12, skip=false → ~3.5s    (complete via skipZeroDelta trick)
 *   dense:       txTarget=31, c=12, skip=false → ~6s      (partial, rate-limit ceiling)
 *
 * Paid-tier (when available):
 *   Delegates to V14 with windowSize=91, maxConcurrency=31, skipZeroDelta=true
 *   Expected: all wallets <2s, score ~1.5-2.0.
 */

import { solBalanceOverTime as solBalanceV14 } from "./sol_balance_v14.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Strategy defaults
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_STRATEGY = {
  // Classification boundary
  sparseThreshold: 12,     // wallets with ≤ N succeeded sigs on page 0 → "sparse"
  sigPageSize: 1000,       // page size for Phase 0 signature fetch
  maxSigPages: 6,          // max pages to scan for succeeded sigs

  // Free-tier per-type params
  txTargetSparse:    8,    // fetch target for sparse wallets
  cSparse:           6,    // max concurrency for sparse wallets
  txTargetMedDense:  31,   // fetch target for medium/dense wallets
  cMedDense:         12,   // max concurrency for medium/dense wallets
  skipZeroDelta:     false,

  // Paid-tier params (used when API tier is "paid")
  paidWindowSize:    91,
  paidWindowTarget:  100,
  paidConcurrency:   31,
  paidSkipZeroDelta: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// API tier detection (cached)
// ─────────────────────────────────────────────────────────────────────────────

const tierCache = { tier: null, expiry: 0 };
const TIER_TTL_MS = 60_000;

// Probe address: sparse wallet (fast, cheap)
const PROBE_ADDRESS = "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs";

async function detectApiTier(apiKey) {
  const now = Date.now();
  if (tierCache.tier && now < tierCache.expiry) return tierCache.tier;

  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTransactionsForAddress",
        params: [PROBE_ADDRESS, {
          transactionDetails: "signatures", sortOrder: "desc", limit: 1,
          filters: { status: "succeeded" },
        }],
      }),
    });
    const json = await res.json().catch(() => null);
    const tier = (res.ok && json && !json.error) ? "paid" : "free";
    tierCache.tier = tier;
    tierCache.expiry = now + TIER_TTL_MS;
    return tier;
  } catch {
    tierCache.tier = "free";
    tierCache.expiry = now + TIER_TTL_MS;
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

  const signatures = (address, limit, before = undefined) => post({
    jsonrpc: "2.0", id: calls + 1,
    method: "getSignaturesForAddress",
    params: [address, { limit, ...(before ? { before } : {}) }],
  });

  const transaction = signature => post({
    jsonrpc: "2.0", id: calls + 1,
    method: "getTransaction",
    params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
  });

  return { signatures, transaction, callCount: () => calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification (zero extra calls)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify wallet density from the first signature page result.
 * @param {number} firstPageRawCount  - total sigs returned in page 0 (raw, not filtered)
 * @param {number} firstPageSucceeded - count of succeeded sigs in page 0
 * @param {boolean} pageWasFull       - true if firstPageRawCount === sigPageSize (more pages exist)
 * @param {number} sparseThreshold    - cutoff for sparse classification
 * @returns {"sparse"|"medium"|"dense"}
 */
function classifyWallet(firstPageRawCount, firstPageSucceeded, pageWasFull, sparseThreshold) {
  if (pageWasFull) return "dense";
  if (firstPageSucceeded <= sparseThreshold) return "sparse";
  return "medium";
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractSample(tx, address) {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const idx  = keys.findIndex(k => (typeof k === "string" ? k : k?.pubkey) === address);
  if (idx < 0) return null;
  const pre  = tx?.meta?.preBalances?.[idx]  ?? 0;
  const post = tx?.meta?.postBalances?.[idx] ?? 0;
  return { slot: tx?.slot ?? 0, blockTime: tx?.blockTime ?? 0,
           signature: tx?.transaction?.signatures?.[0] ?? "",
           preLamports: pre, postLamports: post };
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
      points.push({ slot: s.slot - 1, lamports: lastLamports, kind: "flat" });
    points.push({ slot: s.slot, lamports: s.postLamports, kind: "sample" });
    lastLamports = s.postLamports; lastSlot = s.slot;
  }
  return {
    address, points,
    openingLamports: samples[0]?.preLamports    ?? 0,
    closingLamports: samples.at(-1)?.postLamports ?? 0,
    stats: { totalRpcCalls: rpcCalls, wallTimeMs: wallMs, sampleCount: samples.length,
             openGapsRemaining: 0, resolvedByContinuity: 0, ...meta },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Free-tier solver (density-routed)
// ─────────────────────────────────────────────────────────────────────────────

async function solBalanceFree(address, apiKey, strategy) {
  const t0 = performance.now();

  // Pick per-type params BEFORE rpc creation (concurrency depends on wallet type)
  // We determine concurrency from Phase 0, then create the RPC with appropriate limit.
  // Use the larger concurrency limit for the RPC semaphore — we'll pick the actual
  // target based on classification after page 0.
  const maxC = Math.max(strategy.cSparse, strategy.cMedDense);
  const rpc  = makeRpc(apiKey, maxC);

  // Phase 0: fetch first signature page
  const page0Raw     = await rpc.signatures(address, strategy.sigPageSize);
  const page0        = page0Raw ?? [];
  const pageWasFull  = page0.length >= strategy.sigPageSize;
  const page0Succ    = page0.filter(s => s.err === null);

  // Classify wallet density
  const density = classifyWallet(page0.length, page0Succ.length, pageWasFull, strategy.sparseThreshold);

  // Choose per-type fetch params
  const txTarget = density === "sparse" ? strategy.txTargetSparse : strategy.txTargetMedDense;
  const cTarget  = density === "sparse" ? strategy.cSparse        : strategy.cMedDense;

  // Rebuild RPC with correct concurrency if sparse (reduce semaphore contention)
  const rpcFetch = cTarget === maxC ? rpc : makeRpc(apiKey, cTarget);
  // Note: page0 used a semaphore with maxC permits; rpcFetch is separate for tx fetches

  // Accumulate succeeded sigs up to txTarget
  const succeededSigs = [...page0Succ];

  if (succeededSigs.length < txTarget && !pageWasFull) {
    // Need more pages (shouldn't happen for sparse, but handle gracefully)
    let before = page0.at(-1)?.signature;
    for (let page = 1; page < strategy.maxSigPages && before; page++) {
      const pageData = await rpc.signatures(address, strategy.sigPageSize, before);
      const arr      = pageData ?? [];
      if (!arr.length) break;
      for (const s of arr) { if (s.err === null) succeededSigs.push(s); }
      if (succeededSigs.length >= txTarget) break;
      before = arr.at(-1)?.signature;
      if (arr.length < strategy.sigPageSize) break;
    }
  } else if (succeededSigs.length < txTarget && pageWasFull) {
    // Dense wallet: fetch more pages to reach txTarget
    let before = page0.at(-1)?.signature;
    for (let page = 1; page < strategy.maxSigPages && succeededSigs.length < txTarget && before; page++) {
      const pageData = await rpc.signatures(address, strategy.sigPageSize, before);
      const arr      = pageData ?? [];
      if (!arr.length) break;
      for (const s of arr) { if (s.err === null) succeededSigs.push(s); }
      before = arr.at(-1)?.signature;
      if (arr.length < strategy.sigPageSize) break;
    }
  }

  const selected = succeededSigs.slice(0, txTarget);
  const samples  = [];

  await Promise.all(selected.map(async s => {
    try {
      const tx = await rpcFetch.transaction(s.signature);
      if (!tx) return;
      const sample = extractSample(tx, address);
      if (!sample) return;
      if (strategy.skipZeroDelta && sample.preLamports === sample.postLamports) return;
      samples.push(sample);
    } catch { }
  }));

  const totalCalls = rpc.callCount() + (rpcFetch !== rpc ? rpcFetch.callCount() : 0);
  return buildResult(address, samples, totalCalls, performance.now() - t0,
    { walletDensity: density, apiTier: "free" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function solBalanceOverTime(address, apiKey, strategy = DEFAULT_STRATEGY) {
  const tier = await detectApiTier(apiKey);

  if (tier === "paid") {
    // Delegate to V14 with paid-tier params
    const paidStrategy = {
      sigPageSize:   strategy.sigPageSize ?? 1000,
      windowSize:    strategy.paidWindowSize    ?? 91,
      windowTarget:  strategy.paidWindowTarget  ?? 100,
      maxConcurrency: strategy.paidConcurrency  ?? 31,
      skipZeroDelta: strategy.paidSkipZeroDelta ?? true,
    };
    const result = await solBalanceV14(address, apiKey, paidStrategy);
    return { ...result, stats: { ...result.stats, apiTier: "paid", walletDensity: "n/a" } };
  }

  return solBalanceFree(address, apiKey, strategy);
}

// Force free-tier path regardless of API key (for testing/BO)
export async function solBalanceFreeTierOnly(address, apiKey, strategy = DEFAULT_STRATEGY) {
  return solBalanceFree(address, apiKey, strategy);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const address = process.argv[2];
  const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;
  const force   = process.argv[4]; // "--free" to force free-tier path
  if (!address || !apiKey) {
    console.error("Usage: node sol_balance_hybrid.mjs <address> <api-key> [--free]");
    process.exit(1);
  }
  const fn     = force === "--free" ? solBalanceFreeTierOnly : solBalanceOverTime;
  const result = await fn(address, apiKey);
  const LAMPORTS = 1_000_000_000;
  console.log(`\n${result.address}`);
  console.log("─".repeat(60));
  console.log(`API tier: ${result.stats.apiTier}  Wallet density: ${result.stats.walletDensity}`);
  for (const p of result.points)
    console.log(`slot ${String(p.slot).padStart(12)}  ${(p.lamports / LAMPORTS).toFixed(6)} SOL${p.kind === "flat" ? " [flat]" : ""}`);
  console.log("─".repeat(60));
  console.log(`Samples: ${result.stats.sampleCount}  Calls: ${result.stats.totalRpcCalls}  ${result.stats.wallTimeMs.toFixed(0)}ms`);
}
