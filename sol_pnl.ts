/**
 * SOL Balance History — Adaptive Parallel Algorithm
 *
 * Returns a chronological time series of SOL balance snapshots.
 * Each entry = { blockTime, balanceLamports, deltaLamports, ... }.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Algorithm
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Phase 1  Anchor probes  (2 parallel full calls, always)
 *   Fire newest-100 + oldest-100 full transactions simultaneously.
 *   Fast-exit for wallets with ≤ 100 succeeded transactions (one round trip).
 *   Establishes the time boundary [t_min, t_max] and the "gap" between pages.
 *
 * Phase 2  Single gap probe  (1 signatures call, cheap)
 *   One call fetching up to 1000 signatures for the uncovered gap.
 *
 *   SPARSE path — fewer than 1000 sigs returned (no paginationToken):
 *     The gap is fully enumerated. We know every transaction's exact blockTime.
 *     Build zero-overflow windows (each has exactly ≤ 90 txns) and go to Phase 3.
 *
 *   DENSE path — 1000 sigs returned (paginationToken present):
 *     The gap has ≥ 1000 transactions. Compute density from three measurements
 *     (oldest-page edge, newest-page edge, probe midpoint) and generate
 *     fixed-size time windows for the entire gap. Windows may overflow and
 *     require local pagination, but that's bounded per-window, not global.
 *
 * Phase 3  Parallel full-transaction fetch  (one round trip)
 *   All windows fire simultaneously. Overflow within a single window is handled
 *   with local sequential pagination (rare with proper density sizing).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Performance vs. sequential gSFA + getTransaction
 * ─────────────────────────────────────────────────────────────────────────────
 *   Wallet size       gSFA round trips     This algorithm
 *   ≤ 100 txns              2                   1
 *   ≤ 1,000 txns           10+                  2
 *   ≤ 10,000 txns         100+                  3
 *   Any size           O(N) sequential      3 parallel RTs + local overflow
 *
 * Key difference from recursive bisection approach: Phase 2 is always a single
 * call. Recursive bisection fires O(N/1000 × logN) Phase-2 calls for dense
 * wallets, creating a rate-limit storm. This design caps Phase 2 at 1 call
 * and absorbs the density uncertainty as overflow in Phase 3 instead.
 *
 * API: Helius getTransactionsForAddress
 *   https://www.helius.dev/docs/rpc/gettransactionsforaddress
 */

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface GTFAOptions {
  transactionDetails?: "full" | "signatures";
  sortOrder?: "asc" | "desc";
  limit?: number;
  paginationToken?: string;
  encoding?: string;
  maxSupportedTransactionVersion?: number;
  filters?: {
    blockTime?: { gte?: number; gt?: number; lte?: number; lt?: number };
    status?: "succeeded" | "failed" | "any";
  };
}

interface SigEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
}

interface FullTxEntry {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: Array<{ pubkey: string }> };
  };
  meta: {
    fee: number;
    preBalances: number[];
    postBalances: number[];
    err: object | null;
  };
}

interface GTFASigsResult  { data: SigEntry[];    paginationToken: string | null }
interface GTFAFullResult  { data: FullTxEntry[]; paginationToken: string | null }

export interface BalancePoint {
  blockTime:       number;
  slot:            number;
  signature:       string;
  balanceLamports: number;
  balanceSOL:      number;
  deltaLamports:   number;
}

export interface BalanceHistory {
  address:                 string;
  points:                  BalancePoint[];
  openingBalanceLamports:  number;
  closingBalanceLamports:  number;
  stats: {
    totalApiCalls: number;
    phase1Calls:   number;
    phase2Calls:   number;
    phase3Calls:   number;
    wallTimeMs:    number;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Infrastructure
// ──────────────────────────────────────────────────────────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_CONCURRENCY  = 12;
const MAX_RETRIES      = 4;
const RETRY_BASE_MS    = 250;

function makeSemaphore(limit: number): () => Promise<() => void> {
  let active = 0;
  const queue: Array<() => void> = [];
  return () =>
    new Promise((resolve) => {
      const go = () => { active++; resolve(() => { active--; queue.shift()?.(); }); };
      active < limit ? go() : queue.push(go);
    });
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const transient =
        err.code === "ECONNRESET" ||
        err.message?.includes("429") ||
        err.message?.includes("terminated") ||
        err.message?.includes("fetch failed");
      if (!transient || i === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** i + Math.random() * 100));
    }
  }
  throw new Error("unreachable");
}

function makeClient(apiKey: string) {
  const url     = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const acquire = makeSemaphore(MAX_CONCURRENCY);
  let n = 0;

  const post = <T>(body: unknown): Promise<T> =>
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
          throw new Error(`HTTP ${r.status} 429 ${t.slice(0, 80)}`);
        }
        const j: any = await r.json();
        if (j.error) throw new Error(JSON.stringify(j.error));
        return j.result as T;
      } finally {
        release();
      }
    });

  const full = (address: string, opts: GTFAOptions): Promise<GTFAFullResult> =>
    post({
      jsonrpc: "2.0", id: ++n,
      method: "getTransactionsForAddress",
      params: [address, { transactionDetails: "full", encoding: "jsonParsed",
                          maxSupportedTransactionVersion: 0, ...opts }],
    });

  const sigs = (address: string, opts: GTFAOptions): Promise<GTFASigsResult> =>
    post({
      jsonrpc: "2.0", id: ++n,
      method: "getTransactionsForAddress",
      params: [address, { transactionDetails: "signatures", ...opts }],
    });

  return { full, sigs, callCount: () => n };
}

// ──────────────────────────────────────────────────────────────────────────────
// Window construction helpers
// ──────────────────────────────────────────────────────────────────────────────

/** SPARSE: windows built from exact signature positions — zero overflow risk. */
function windowsFromSigs(
  sigList: SigEntry[],
  size = 90
): Array<{ t_start: number; t_end: number }> {
  const out: Array<{ t_start: number; t_end: number }> = [];
  for (let i = 0; i < sigList.length; i += size) {
    const chunk   = sigList.slice(i, i + size);
    const t_start = chunk[0].blockTime!;
    const next    = sigList[i + size];
    const t_end   = next ? next.blockTime! : chunk.at(-1)!.blockTime! + 1;
    out.push({ t_start, t_end });
  }
  return out;
}

/** DENSE: windows sized by density estimate — some may need overflow pagination. */
function windowsFromDensity(
  t_start: number,
  t_end:   number,
  density: number,     // transactions per second
  target  = 80        // target txns per window (below 100 API limit)
): Array<{ t_start: number; t_end: number }> {
  const windowSecs = Math.max(1, Math.floor(target / density));
  const out: Array<{ t_start: number; t_end: number }> = [];
  for (let t = t_start; t < t_end; t += windowSecs) {
    out.push({ t_start: t, t_end: Math.min(t + windowSecs, t_end) });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 3: fetch all transactions in one time window
// ──────────────────────────────────────────────────────────────────────────────

async function fetchWindow(
  address:  string,
  rpcFull:  ReturnType<typeof makeClient>["full"],
  t_start:  number,
  t_end:    number,
  p3:       { n: number }
): Promise<FullTxEntry[]> {
  const all: FullTxEntry[] = [];
  let token: string | null = null;
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

// ──────────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────────

function dedup(txns: FullTxEntry[]): FullTxEntry[] {
  const seen = new Set<string>();
  return txns.filter((tx) => {
    const s = tx.transaction.signatures[0];
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

function toBalancePoints(txns: FullTxEntry[], address: string): BalancePoint[] {
  return txns.flatMap((tx) => {
    const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === address);
    if (i === -1) return [];
    const pre  = tx.meta.preBalances[i]  ?? 0;
    const post = tx.meta.postBalances[i] ?? 0;
    return [{
      blockTime:       tx.blockTime ?? 0,
      slot:            tx.slot,
      signature:       tx.transaction.signatures[0],
      balanceLamports: post,
      balanceSOL:      post / LAMPORTS_PER_SOL,
      deltaLamports:   post - pre,
    }];
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function solBalanceHistory(
  address: string,
  apiKey:  string
): Promise<BalanceHistory> {
  const t0  = performance.now();
  const rpc = makeClient(apiKey);
  const p2  = { n: 0 };
  const p3  = { n: 0 };

  // ── Phase 1: anchor probes ──────────────────────────────────────────────────
  const baseFilter = { status: "succeeded" as const };
  const [newest, oldest] = await Promise.all([
    rpc.full(address, { sortOrder: "desc", limit: 100, filters: baseFilter }),
    rpc.full(address, { sortOrder: "asc",  limit: 100, filters: baseFilter }),
  ]);

  let allTxns: FullTxEntry[];

  if (!newest.paginationToken) {
    // ≤ 100 transactions — fast path
    allTxns = newest.data;
  } else {
    const t_min           = oldest.data[0]?.blockTime  ?? 0;
    const t_max           = newest.data[0]?.blockTime  ?? (Date.now() / 1000);
    const t_after_oldest  = (oldest.data.at(-1)?.blockTime ?? t_min) + 1;
    const t_before_newest =  newest.data.at(-1)?.blockTime ?? t_max;

    if (t_after_oldest >= t_before_newest) {
      allTxns = dedup([...oldest.data, ...newest.data]);
    } else {
      // ── Phase 2: single gap probe ─────────────────────────────────────────────
      p2.n++;
      const probe = await rpc.sigs(address, {
        sortOrder: "asc", limit: 1000,
        filters: { status: "succeeded", blockTime: { gte: t_after_oldest, lt: t_before_newest } },
      });

      let wins: Array<{ t_start: number; t_end: number }>;

      if (!probe.paginationToken) {
        // SPARSE: exact positions known — zero-overflow windows
        wins = windowsFromSigs(probe.data, 90);
      } else {
        // DENSE: estimate density from three sources, take max for conservatism
        const t_probe_end = probe.data.at(-1)!.blockTime!;
        const d_oldest    = 100  / Math.max(1, t_after_oldest  - t_min);
        const d_newest    = 100  / Math.max(1, t_max - t_before_newest);
        const d_probe     = 1000 / Math.max(1, t_probe_end - t_after_oldest);
        const density     = Math.max(d_oldest, d_newest, d_probe);
        wins = windowsFromDensity(t_after_oldest, t_before_newest, density, 80);
      }

      // ── Phase 3: parallel full-transaction fetch ──────────────────────────────
      const gapTxns = (
        await Promise.all(wins.map((w) => fetchWindow(address, rpc.full, w.t_start, w.t_end, p3)))
      ).flat();

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
      phase1Calls:   2,
      phase2Calls:   p2.n,
      phase3Calls:   p3.n,
      wallTimeMs:    performance.now() - t0,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI (Deno)
// ──────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const address = Deno.args[0];
  const apiKey  = Deno.args[1] ?? Deno.env.get("HELIUS_API_KEY");

  if (!address || !apiKey) {
    console.error("Usage: deno run --allow-net sol_pnl.ts <ADDRESS> [API_KEY]");
    Deno.exit(1);
  }

  console.log(`Fetching SOL balance history for ${address}...`);
  const h = await solBalanceHistory(address, apiKey);

  console.log(`\nSOL Balance History — ${h.address}`);
  console.log("─".repeat(80));
  console.log("Date".padEnd(26) + "Balance (SOL)".padStart(16) + "Delta (SOL)".padStart(16) + "  Signature");
  console.log("─".repeat(80));

  for (const p of h.points) {
    const date  = new Date(p.blockTime * 1000).toISOString();
    const bal   = (p.balanceLamports / LAMPORTS_PER_SOL).toFixed(6);
    const delta = (p.deltaLamports   / LAMPORTS_PER_SOL).toFixed(6);
    const sign  = p.deltaLamports >= 0 ? "+" : "";
    console.log(date.padEnd(26) + bal.padStart(16) + `${sign}${delta}`.padStart(16) + `  ${p.signature.slice(0, 20)}...`);
  }

  console.log("─".repeat(80));
  console.log(`Opening: ${(h.openingBalanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL  →  Closing: ${(h.closingBalanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Transactions:    ${h.points.length}`);
  console.log(`Total API calls: ${h.stats.totalApiCalls} (P1:${h.stats.phase1Calls} P2:${h.stats.phase2Calls} P3:${h.stats.phase3Calls})`);
  console.log(`Wall time:       ${h.stats.wallTimeMs.toFixed(0)}ms`);
}
