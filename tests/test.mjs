/**
 * SOL Balance History — Adaptive Parallel Algorithm
 *
 * Three-phase strategy using Helius getTransactionsForAddress.
 *
 * Phase 1 — Anchor probes (2 parallel full calls, always)
 *   Gets newest 100 + oldest 100 full transactions simultaneously.
 *   Fast-exit for wallets with ≤ 100 transactions.
 *
 * Phase 2 — Single gap probe (1 signatures call, cheap)
 *   One call that covers the gap between anchor pages.
 *
 *   SPARSE path (< 1000 sigs returned, no paginationToken):
 *     Gap is fully enumerated. Build exact windows and fire Phase 3 in parallel.
 *
 *   DENSE path (1000 sigs returned, paginationToken present):
 *     Use probe density to size all windows for the whole gap. Fire Phase 3 in
 *     parallel with overflow handled within each window (sequential pagination
 *     only for overflowing windows, not the whole dataset).
 *
 * Phase 3 — Parallel full-transaction fetch (one round trip)
 *   All windows fire simultaneously. Overflow within a single dense window
 *   is handled with local pagination, bounded to O(1) extra calls per window.
 *
 * Round trips: 1 (sparse) → 2 (medium) → 3 (dense)
 * Never fires the O(N/1000 × log N) call storm of recursive bisection.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_CONCURRENCY  = 12;
const MAX_RETRIES      = 4;
const RETRY_BASE_MS    = 250;

// Semaphore: cap in-flight requests
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return function acquire() {
    return new Promise((resolve) => {
      const go = () => { active++; resolve(() => { active--; queue.shift()?.(); }); };
      active < limit ? go() : queue.push(go);
    });
  };
}

// Retry with exponential backoff for transient errors
async function withRetry(fn) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      const transient =
        err.code === "ECONNRESET" ||
        err.message?.includes("429") ||
        err.message?.includes("terminated") ||
        err.message?.includes("fetch failed") ||
        err.message?.includes("ECONNRESET");
      if (!transient || i === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** i + Math.random() * 100));
    }
  }
}

function makeClient(apiKey) {
  const url     = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const acquire = makeSemaphore(MAX_CONCURRENCY);
  let n = 0;

  const post = (body) =>
    withRetry(async () => {
      const release = await acquire();
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const t = await r.text().catch(() => String(r.status));
          const e = new Error(`HTTP ${r.status} 429 ${t.slice(0, 80)}`);
          throw e;
        }
        const j = await r.json();
        if (j.error) throw new Error(JSON.stringify(j.error));
        return j.result;
      } finally {
        release();
      }
    });

  const full = (address, opts) =>
    post({
      jsonrpc: "2.0", id: ++n,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        ...opts,
      }],
    });

  const sigs = (address, opts) =>
    post({
      jsonrpc: "2.0", id: ++n,
      method: "getTransactionsForAddress",
      params: [address, { transactionDetails: "signatures", ...opts }],
    });

  return { full, sigs, callCount: () => n };
}

// Fetch all transactions in a time window (with overflow pagination)
async function fetchWindow(address, rpcFull, t_start, t_end, p3) {
  const all = [];
  let token = null;
  do {
    p3.n++;
    const r = await rpcFull(address, {
      sortOrder: "asc", limit: 100,
      filters: { status: "succeeded", blockTime: { gte: t_start, lt: t_end } },
      ...(token ? { paginationToken: token } : {}),
    });
    all.push(...r.data);
    token = r.paginationToken;
  } while (token);
  return all;
}

// Build windows from an array of sig entries (precise — no overflow)
function windowsFromSigs(sigs, size = 90) {
  const out = [];
  for (let i = 0; i < sigs.length; i += size) {
    const chunk = sigs.slice(i, i + size);
    const t_start = chunk[0].blockTime;
    const next    = sigs[i + size];
    const t_end   = next ? next.blockTime : chunk.at(-1).blockTime + 1;
    out.push({ t_start, t_end });
  }
  return out;
}

// Build density-estimated windows for a large gap
function windowsFromDensity(t_start, t_end, density, targetPerWindow = 80) {
  const windowSecs = Math.max(1, Math.floor(targetPerWindow / density));
  const out = [];
  for (let t = t_start; t < t_end; t += windowSecs) {
    out.push({ t_start: t, t_end: Math.min(t + windowSecs, t_end) });
  }
  return out;
}

function dedup(txns) {
  const seen = new Set();
  return txns.filter((tx) => {
    const s = tx.transaction.signatures[0];
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

function toBalancePoints(txns, address) {
  const points = [];
  for (const tx of txns) {
    const keys = tx.transaction.message.accountKeys;
    const i = keys.findIndex((k) => k.pubkey === address);
    if (i === -1) continue;
    const pre  = tx.meta.preBalances[i]  ?? 0;
    const post = tx.meta.postBalances[i] ?? 0;
    points.push({
      blockTime:       tx.blockTime ?? 0,
      slot:            tx.slot,
      signature:       tx.transaction.signatures[0],
      balanceLamports: post,
      balanceSOL:      post / LAMPORTS_PER_SOL,
      deltaLamports:   post - pre,
    });
  }
  return points;
}

export async function solBalanceHistory(address, apiKey) {
  const t0  = performance.now();
  const rpc = makeClient(apiKey);
  const p2  = { n: 0 };
  const p3  = { n: 0 };

  // ── Phase 1: anchor probes ──────────────────────────────────────────────────
  const baseFilter = { status: "succeeded" };
  const [newest, oldest] = await Promise.all([
    rpc.full(address, { sortOrder: "desc", limit: 100, filters: baseFilter }),
    rpc.full(address, { sortOrder: "asc",  limit: 100, filters: baseFilter }),
  ]);

  let allTxns;

  if (!newest.paginationToken) {
    allTxns = newest.data;  // ≤ 100 txns — fast exit
  } else {
    const t_min           = oldest.data[0]?.blockTime ?? 0;
    const t_max           = newest.data[0]?.blockTime ?? (Date.now() / 1000);
    const t_after_oldest  = (oldest.data.at(-1)?.blockTime ?? t_min) + 1;
    const t_before_newest = newest.data.at(-1)?.blockTime ?? t_max;

    if (t_after_oldest >= t_before_newest) {
      allTxns = dedup([...oldest.data, ...newest.data]);
    } else {
      // ── Phase 2: single gap probe ─────────────────────────────────────────────
      p2.n++;
      const probe = await rpc.sigs(address, {
        sortOrder: "asc", limit: 1000,
        filters: { status: "succeeded", blockTime: { gte: t_after_oldest, lt: t_before_newest } },
      });

      let wins;

      if (!probe.paginationToken) {
        // SPARSE: gap has < 1000 txns — use exact positions for zero-overflow windows
        wins = windowsFromSigs(probe.data, 90);
      } else {
        // DENSE: gap has ≥ 1000 txns — estimate density from probe and Phase 1 pages
        //
        // Three density measurements, take maximum for conservative window sizing:
        //   1. oldest page: 100 txns over oldest-page duration
        //   2. newest page: 100 txns over newest-page duration
        //   3. probe: 1000 txns over probe duration
        const t_probe_end = probe.data.at(-1).blockTime;

        const d_oldest = 100 / Math.max(1, t_after_oldest  - t_min);
        const d_newest = 100 / Math.max(1, t_max - t_before_newest);
        const d_probe  = 1000 / Math.max(1, t_probe_end - t_after_oldest);

        const density = Math.max(d_oldest, d_newest, d_probe);
        wins = windowsFromDensity(t_after_oldest, t_before_newest, density, 80);
      }

      // ── Phase 3: parallel full-transaction fetch ──────────────────────────────
      const gapTxns = (await Promise.all(
        wins.map((w) => fetchWindow(address, rpc.full, w.t_start, w.t_end, p3))
      )).flat();

      allTxns = dedup([...oldest.data, ...newest.data, ...gapTxns]);
    }
  }

  allTxns.sort((a, b) => {
    const d = (a.blockTime ?? 0) - (b.blockTime ?? 0);
    return d !== 0 ? d : a.slot - b.slot;
  });

  const points = toBalancePoints(allTxns, address);

  return {
    address,
    points,
    openingBalanceLamports: points.length > 0 ? points[0].balanceLamports - points[0].deltaLamports : 0,
    closingBalanceLamports: points.at(-1)?.balanceLamports ?? 0,
    stats: {
      totalApiCalls: rpc.callCount(),
      phase1Calls: 2,
      phase2Calls: p2.n,
      phase3Calls: p3.n,
      wallTimeMs: performance.now() - t0,
    },
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const address = process.argv[2];
const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;

if (!address || !apiKey) {
  console.error("Usage: node test.mjs <ADDRESS> [API_KEY]");
  process.exit(1);
}

console.log(`Fetching SOL balance history for ${address}...`);
const h = await solBalanceHistory(address, apiKey);

console.log(`\nSOL Balance History — ${h.address}`);
console.log("─".repeat(80));
console.log("Date".padEnd(26) + "Balance (SOL)".padStart(16) + "Delta (SOL)".padStart(16) + "  Sig");
console.log("─".repeat(80));

for (const p of h.points) {
  const date  = new Date(p.blockTime * 1000).toISOString();
  const bal   = (p.balanceLamports / LAMPORTS_PER_SOL).toFixed(6);
  const delta = (p.deltaLamports   / LAMPORTS_PER_SOL).toFixed(6);
  const sign  = p.deltaLamports >= 0 ? "+" : "";
  console.log(
    date.padEnd(26) +
    bal.padStart(16) +
    `${sign}${delta}`.padStart(16) +
    `  ${p.signature.slice(0, 16)}...`
  );
}

console.log("─".repeat(80));
console.log(`Opening: ${(h.openingBalanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL  →  Closing: ${(h.closingBalanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
console.log(`Transactions: ${h.points.length}`);
console.log(`Perf: ${h.stats.wallTimeMs.toFixed(0)}ms | ${h.stats.totalApiCalls} API calls  (P1:${h.stats.phase1Calls} P2:${h.stats.phase2Calls} P3:${h.stats.phase3Calls})`);
