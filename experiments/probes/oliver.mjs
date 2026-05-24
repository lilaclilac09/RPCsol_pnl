/**
 * oliver.mjs — Ultra-low latency parallel API client
 *
 * Oliver's core primitives from sol_pnl.ts, extracted as a reusable module.
 *
 * Pattern:
 *   1. makeSemaphore  — cap concurrent in-flight requests
 *   2. withRetry      — exponential backoff on 429/503/ECONNRESET
 *   3. Promise.all    — fire everything simultaneously
 *   4. timed()        — per-call ms + bytes + credit tracking
 *
 * Usage:
 *   import { makeHelius, timed, parallel } from "./oliver.mjs";
 *
 *   const helius = makeHelius(process.env.HELIUS_API_KEY);
 *
 *   const results = await parallel([
 *     timed("getBalance",  () => helius.rpc("getBalance", [address])),
 *     timed("getAssets",   () => helius.das("getAssetsByOwner", { ownerAddress: address, page:1, limit:20 })),
 *     timed("priorityFee", () => helius.rpc("getPriorityFeeEstimate", [{ accountKeys:[address], options:{includeAllPriorityFeeLevels:true} }])),
 *   ]);
 *
 *   printTable(results);
 *
 * Paid plan unlocks:
 *   helius.gtfa(address, { transactionDetails:"full", limit:100, sortOrder:"desc", filters:{ status:"succeeded" } })
 *   → getTransactionsForAddress — Oliver's Phase 1/2/3 core, sub-1s for any wallet size
 */

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULTS = {
  maxConcurrency: 12,   // Oliver uses 12 in sol_pnl.ts
  maxRetries:      4,
  retryBaseMs:   250,
};

// ─────────────────────────────────────────────────────────────────────────────
// Primitive 1: Semaphore — cap concurrent requests
// Copied verbatim from sol_pnl.ts makeSemaphore()
// ─────────────────────────────────────────────────────────────────────────────

export function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return () => new Promise(resolve => {
    const go = () => { active++; resolve(() => { active--; queue.shift()?.(); }); };
    active < limit ? go() : queue.push(go);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive 2: withRetry — exponential backoff on transient errors
// Copied verbatim from sol_pnl.ts withRetry()
// ─────────────────────────────────────────────────────────────────────────────

export async function withRetry(fn, { maxRetries = DEFAULTS.maxRetries, retryBaseMs = DEFAULTS.retryBaseMs } = {}) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message ?? "");
      const transient = /429|503|ECONNRESET|fetch failed|terminated/i.test(msg);
      if (!transient || i === maxRetries) throw err;
      await new Promise(r => setTimeout(r, retryBaseMs * 2 ** i + Math.random() * 100));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive 3: timed() — wraps any async fn, captures ms + bytes
// ─────────────────────────────────────────────────────────────────────────────

export async function timed(label, fn, credits = 1) {
  const t0 = performance.now();
  try {
    const result = await fn();
    const ms    = performance.now() - t0;
    const bytes = JSON.stringify(result).length;
    return { label, status: "ok", result, ms, bytes, credits };
  } catch (err) {
    const ms = performance.now() - t0;
    return { label, status: "err", error: err?.message ?? String(err), ms, bytes: 0, credits: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive 4: parallel() — Oliver's Promise.all wrapper
// Fires all tasks simultaneously, returns results in input order
// ─────────────────────────────────────────────────────────────────────────────

export async function parallel(tasks) {
  const t0 = performance.now();
  const results = await Promise.all(tasks);
  return { results, wallMs: performance.now() - t0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// makeHelius() — pre-wired Helius client
// Returns rpc(), das(), rest(), gtfa() all gated by the same semaphore
// ─────────────────────────────────────────────────────────────────────────────

export function makeHelius(apiKey, { maxConcurrency = DEFAULTS.maxConcurrency } = {}) {
  if (!apiKey) throw new Error("HELIUS_API_KEY required");

  const acquire = makeSemaphore(maxConcurrency);
  const RPC_URL  = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const REST_URL = `https://api.helius.xyz`;
  let id = 0;

  // POST to RPC endpoint
  async function rpcPost(method, params) {
    return withRetry(async () => {
      const release = await acquire();
      try {
        const r = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
        const j = await r.json();
        if (j.error) throw new Error(`[${j.error.code}] ${j.error.message}`);
        return j.result;
      } finally { release(); }
    });
  }

  // GET to Enhanced REST endpoint
  async function restGet(path) {
    return withRetry(async () => {
      const release = await acquire();
      try {
        const sep = path.includes("?") ? "&" : "?";
        const r = await fetch(`${REST_URL}${path}${sep}api-key=${apiKey}`);
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
        return r.json();
      } finally { release(); }
    });
  }

  // POST to Enhanced REST endpoint
  async function restPost(path, body) {
    return withRetry(async () => {
      const release = await acquire();
      try {
        const r = await fetch(`${REST_URL}${path}?api-key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
        return r.json();
      } finally { release(); }
    });
  }

  return {
    // Standard Solana RPC — free tier
    // e.g. helius.rpc("getBalance", [address])
    rpc: rpcPost,

    // Helius DAS API (Digital Asset Standard) — free tier
    // Note: DAS methods take a plain object, not an array
    // e.g. helius.das("getAssetsByOwner", { ownerAddress: address, page: 1 })
    das: (method, params) => rpcPost(method, params),

    // Helius Enhanced REST — free tier, slower (server-side enrichment)
    // e.g. helius.rest.get("/v0/addresses/ABC.../transactions?limit=10")
    rest: { get: restGet, post: restPost },

    // getTransactionsForAddress — PAID PLAN ONLY
    // Oliver's core method. Returns full tx data + supports filters in one RPC call.
    // Phase 1 pattern: fire 2 in parallel (newest desc + oldest asc) → sub-1s any wallet
    //
    // helius.gtfa(address, { transactionDetails:"full", limit:100, sortOrder:"desc" })
    // helius.gtfa(address, { transactionDetails:"signatures", limit:1000, sortOrder:"asc" })
    // helius.gtfa(address, { transactionDetails:"full", limit:100, filters:{ status:"succeeded", blockTime:{ gte:t0, lt:t1 } } })
    gtfa: (address, opts) => rpcPost("getTransactionsForAddress", [address, {
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
      ...opts,
    }]),

    // Oliver's Phase 1: anchor probes fired in parallel
    // Returns [newestPage, oldestPage] simultaneously
    // Establishes time boundary [t_min, t_max] for the whole wallet history
    phase1: (address, limit = 100) => Promise.all([
      rpcPost("getTransactionsForAddress", [address, {
        transactionDetails: "full", encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        sortOrder: "desc", limit,
        filters: { status: "succeeded" },
      }]),
      rpcPost("getTransactionsForAddress", [address, {
        transactionDetails: "full", encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        sortOrder: "asc", limit,
        filters: { status: "succeeded" },
      }]),
    ]),

    // Free tier: paginate all signatures for a wallet (sequential, slow on large wallets)
    // Returns total count. Use only when you need an exact count on free tier.
    countTxs: async (address) => {
      let total = 0, before;
      while (true) {
        const page = await rpcPost("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
        if (!page?.length) break;
        total += page.length;
        if (page.length < 1000) break;
        before = page.at(-1).signature;
      }
      return total;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// printTable() — pretty summary table for parallel() results
// ─────────────────────────────────────────────────────────────────────────────

export function printTable({ results, wallMs }) {
  const ok  = results.filter(r => r.status === "ok");
  const err = results.filter(r => r.status === "err");
  const totalCredits = results.reduce((s, r) => s + r.credits, 0);
  const totalBytes   = results.reduce((s, r) => s + r.bytes, 0);
  const seqMs        = results.reduce((s, r) => s + r.ms, 0);

  console.log();
  for (const r of results) {
    const icon = r.status === "ok" ? "✓" : "✗";
    const ms   = `${r.ms.toFixed(0)}ms`.padEnd(7);
    const kb   = `${(r.bytes / 1024).toFixed(1)} KB`.padStart(8);
    const cred = r.credits ? `${r.credits}cr` : "  -";
    console.log(`${icon} ${r.label.padEnd(28)} ${ms} ${kb}  ${cred}`);
    if (r.status === "err") console.log(`  └─ ${r.error}`);
  }

  console.log(`${"─".repeat(56)}`);
  console.log(`  ${ok.length}/${results.length} ok  │  wall ${wallMs.toFixed(0)}ms  │  seq ~${seqMs.toFixed(0)}ms  │  ${(seqMs/wallMs).toFixed(1)}× gain`);
  console.log(`  ${totalCredits} credits  │  ${(totalBytes/1024).toFixed(1)} KB  │  free tier: ${Math.floor(100000/Math.max(1,totalCredits)).toLocaleString()} runs/mo`);
  if (err.length) console.log(`  ${err.length} errors: ${err.map(r=>r.label).join(", ")}`);
}
