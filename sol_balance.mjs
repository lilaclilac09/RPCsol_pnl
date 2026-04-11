/**
 * SOL Balance Over Time — Hybrid Algorithm
 *
 * Merges our 3-phase adaptive approach with the competitor's best ideas:
 *   1. Golomb-ruler probing for alias-free multi-scale density sampling
 *   2. Balance-continuity oracle: if lastWindow.post === nextWindow.pre,
 *      the gap is provably flat — zero extra RPC calls
 *   3. Slot-based filtering (not blockTime) — monotonic, no skew
 *   4. Zero-delta skip: only emit actual SOL balance changes
 *   5. Budget cap (default 40 calls) — bounds busy-wallet latency
 *   6. Delta-weighted water-filling for remaining open gaps
 *
 * Controlled by a strategy config object so the autoresearch loop can
 * mutate and evaluate different parameter combinations.
 */

export const DEFAULT_STRATEGY = {
  // --- Probe phase ---
  golombOrder: 6,          // Golomb ruler order (5 windows from order-6 ruler)
  probeWindowLimit: 100,   // max full txns fetched per probe window
  phase1AnchorSize: 100,   // newest/oldest full txns in anchor phase

  // --- Gap resolution ---
  maxRpcCalls: 40,         // total budget ceiling
  maxRounds: 4,            // refinement rounds after initial probe
  windowLimit: 100,        // per-window sample cap in refinement

  // --- Window sizing (dense path) ---
  targetTxnsPerWindow: 80, // target txns per generated window

  // --- Concurrency ---
  maxConcurrency: 12,

  // --- Oracle ---
  useContinuityOracle: true,  // prune flat gaps via pre/post balance check
  skipZeroDelta: true,        // skip txns where preBalance === postBalance

  // --- Budget strategy ---
  deltaWeightedFill: true,    // prioritise gaps by |delta| when filling
};

// ──────────────────────────────────────────────────────────────────────────────
// Infrastructure
// ──────────────────────────────────────────────────────────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000;
const RETRY_BASE_MS    = 250;
const MAX_RETRIES      = 4;

function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return () => new Promise((resolve) => {
    const go = () => { active++; resolve(() => { active--; queue.shift()?.(); }); };
    active < limit ? go() : queue.push(go);
  });
}

async function withRetry(fn) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try { return await fn(); }
    catch (err) {
      const transient = err.code === "ECONNRESET" || err.message?.includes("429") ||
                        err.message?.includes("terminated") || err.message?.includes("fetch failed");
      if (!transient || i === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * 2**i + Math.random() * 100));
    }
  }
}

function makeClient(apiKey, maxConcurrency) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const acquire = makeSemaphore(maxConcurrency);
  let n = 0;

  const post = (body) => withRetry(async () => {
    const release = await acquire();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => String(r.status));
        throw new Error(`HTTP ${r.status} 429 ${t.slice(0, 60)}`);
      }
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } finally { release(); }
  });

  const getSlot = () => post({
    jsonrpc: "2.0", id: ++n,
    method: "getSlot",
    params: [{ commitment: "confirmed" }],
  });

  // Fetch full transactions for a slot range (sortOrder: "asc" default)
  const fetchSlotWindow = (address, fromSlot, toSlot, limit, status = "succeeded", paginationToken = null, sortOrder = "asc") =>
    post({
      jsonrpc: "2.0", id: ++n,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        sortOrder,
        limit,
        filters: {
          ...(fromSlot > 0 || toSlot < 999_999_999
            ? { slot: { gte: fromSlot, lte: toSlot } }
            : {}),
          status,
          tokenAccounts: "none",
        },
        ...(paginationToken ? { paginationToken } : {}),
      }],
    });

  // Fetch signatures for a slot range (cheap, 1000/call)
  const fetchSlotSigs = (address, fromSlot, toSlot, limit = 1000, paginationToken = null) =>
    post({
      jsonrpc: "2.0", id: ++n,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "signatures",
        sortOrder: "asc",
        limit,
        filters: {
          slot: { gte: fromSlot, lte: toSlot },
          status: "succeeded",
          tokenAccounts: "none",
        },
        ...(paginationToken ? { paginationToken } : {}),
      }],
    });

  return { getSlot, fetchSlotWindow, fetchSlotSigs, callCount: () => n };
}

// ──────────────────────────────────────────────────────────────────────────────
// Golomb-ruler window placement
// ──────────────────────────────────────────────────────────────────────────────

// Perfect Golomb rulers by order (order = number of marks)
const GOLOMB_RULERS = {
  4: [0, 1, 3, 6],
  5: [0, 1, 3, 7, 12],
  6: [0, 1, 4, 10, 12, 17],
  7: [0, 1, 2, 10, 16, 24, 28],  // near-perfect
  8: [0, 1, 4, 9, 15, 22, 32, 34],
};

function golombWindows(fromSlot, toSlot, order = 6) {
  const ruler = GOLOMB_RULERS[order] ?? GOLOMB_RULERS[6];
  const span  = Math.max(1, toSlot - fromSlot);
  const max   = ruler[ruler.length - 1];
  const edges = ruler.map(m => fromSlot + Math.round((m / max) * span));
  const wins  = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1];
    if (b > a) wins.push({ fromSlot: a, toSlot: b });
  }
  return wins;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sample extraction from a full transaction response
// ──────────────────────────────────────────────────────────────────────────────

function extractSamples(data, address, skipZeroDelta) {
  const samples = [];
  for (const entry of data) {
    if (!entry.meta) continue;
    const keys = entry.transaction.message.accountKeys;
    const idx  = keys.findIndex(k => (typeof k === "string" ? k : k?.pubkey) === address);
    if (idx < 0) continue;
    const pre  = entry.meta.preBalances[idx]  ?? 0;
    const post = entry.meta.postBalances[idx] ?? 0;
    if (skipZeroDelta && pre === post) continue;
    samples.push({
      slot:        entry.slot,
      signature:   entry.transaction.signatures[0] ?? "",
      preLamports: pre,
      postLamports: post,
    });
  }
  return samples;
}

// ──────────────────────────────────────────────────────────────────────────────
// Core window fetch (with overflow pagination)
// ──────────────────────────────────────────────────────────────────────────────

async function fetchWindow(rpc, address, fromSlot, toSlot, limit, strategy, callCounter) {
  const samples = [];
  let token     = null;
  let truncated = false;

  do {
    callCounter.n++;
    const r = await rpc.fetchSlotWindow(address, fromSlot, toSlot, Math.min(100, limit - samples.length), "succeeded", token);
    const page = r.data ?? [];
    samples.push(...extractSamples(page, address, strategy.skipZeroDelta));
    token = r.paginationToken;
    if (samples.length >= limit && token) { truncated = true; break; }
  } while (token && samples.length < limit);

  return { fromSlot, toSlot, samples, truncated };
}


function deduplicateSamples(samples) {
  const seen = new Set();
  return samples.filter(s => {
    const k = s.signature || `${s.slot}:${s.preLamports}:${s.postLamports}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.slot - b.slot);
}

function buildResult(address, samples, totalCalls, wallMs, resolvedByContinuity, openGapsRemaining) {
  const sorted = deduplicateSamples(samples);
  const points = [];
  let lastLamports = null, lastSlot = null;
  for (const s of sorted) {
    if (lastLamports !== null && lastSlot !== null && lastLamports !== s.preLamports && s.slot > lastSlot + 1)
      points.push({ slot: s.slot - 1, lamports: lastLamports, kind: "flat" });
    points.push({ slot: s.slot, lamports: s.postLamports, kind: "sample" });
    lastLamports = s.postLamports;
    lastSlot = s.slot;
  }
  return {
    address,
    points,
    openingLamports: sorted[0]?.preLamports ?? 0,
    closingLamports: sorted.at(-1)?.postLamports ?? 0,
    stats: { totalRpcCalls: totalCalls, wallTimeMs: wallMs, resolvedByContinuity, openGapsRemaining, sampleCount: sorted.length },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main algorithm
// ──────────────────────────────────────────────────────────────────────────────

export async function solBalanceOverTime(address, apiKey, strategy = DEFAULT_STRATEGY) {
  const t0  = performance.now();
  const rpc = makeClient(apiKey, strategy.maxConcurrency);
  const p   = { n: 0 };

  // ── Phase 0: Anchor probes ─────────────────────────────────────────────────
  // Two parallel calls: newest N (desc) + oldest N (asc), no slot filter.
  // This bounds the wallet's actual activity to [minSlot, maxSlot], avoiding
  // probing from slot 0 (the competitor's blind spot — wastes time on 400M
  // empty slots for wallets created in 2025/2026).
  // Fast-exit if wallet has ≤ probeWindowLimit succeeded transactions.
  const anchorLimit = strategy.probeWindowLimit;

  const [newestRaw, oldestRaw] = await Promise.all([
    rpc.fetchSlotWindow(address, 0, 999_999_999, Math.min(100, anchorLimit), "succeeded", null, "desc"),
    rpc.fetchSlotWindow(address, 0, 999_999_999, Math.min(100, anchorLimit), "succeeded", null, "asc"),
  ]);
  p.n += 2;

  const newestSamples  = extractSamples(newestRaw.data ?? [], address, strategy.skipZeroDelta).reverse();
  const oldestSamples  = extractSamples(oldestRaw.data ?? [], address, strategy.skipZeroDelta);
  const newestTruncated = !!newestRaw.paginationToken;
  const oldestTruncated = !!oldestRaw.paginationToken;

  // Fast exit 1: desc page fit everything (no more transactions exist)
  // NOTE: Helius sometimes returns a non-null paginationToken even when the full
  // history fits in one page. So we can't rely on paginationToken alone.
  // Fast exit 2: the two anchor pages OVERLAP — oldest page's last slot is >= newest
  // page's first slot, meaning together they cover the entire history.
  const oldestLastSlot  = oldestSamples.at(-1)?.slot ?? -1;
  const newestFirstSlot = newestSamples[0]?.slot ?? Infinity;

  if (!newestTruncated || oldestLastSlot >= newestFirstSlot) {
    const combined = deduplicateSamples([...oldestSamples, ...newestSamples]);
    return buildResult(address, combined, rpc.callCount(), performance.now() - t0, 0, 0);
  }

  // Wallet has more than probeWindowLimit transactions in the gap.
  const minSlot = oldestSamples[0]?.slot ?? 0;
  const maxSlot = newestSamples.at(-1)?.slot ?? newestSamples[0]?.slot ?? (await rpc.getSlot());

  // ── Phase 1: Golomb-ruler probe across actual activity range ───────────────
  // Probe [minSlot, maxSlot] — the wallet's ACTUAL history, not [0, tipSlot].
  // Anchor data covers the first and last pages; Golomb covers the middle.
  const probeRanges = golombWindows(minSlot, maxSlot, strategy.golombOrder);
  const probeResults = await Promise.all(
    probeRanges.map(({ fromSlot, toSlot }) =>
      fetchWindow(rpc, address, fromSlot, toSlot, strategy.probeWindowLimit, strategy, p)
    )
  );

  // Seed windows with both anchor pages + Golomb results
  let windows = [
    { fromSlot: minSlot,    toSlot: minSlot,    samples: oldestSamples, truncated: oldestTruncated },
    ...probeResults,
    { fromSlot: maxSlot,    toSlot: maxSlot,    samples: newestSamples, truncated: false },
  ].sort((a, b) => a.fromSlot - b.fromSlot);
  let rpcCalls = 2 + probeResults.length; // 2 anchor calls + probe calls
  let resolvedByContinuity = 0;

  // ── Phases 2..N: continuity oracle + water-fill refinement ────────────────
  for (let round = 0; round < strategy.maxRounds && rpc.callCount() < strategy.maxRpcCalls; round++) {
    const totalSamples = windows.reduce((n, w) => n + w.samples.length, 0);

    // Sparse short-circuit: if all windows resolved and few samples, done.
    if (windows.every(w => !w.truncated) && totalSamples < 30) break;

    const openGaps = [];

    // 1. Split truncated windows
    for (const w of windows) {
      if (!w.truncated) continue;
      const mid = Math.floor((w.fromSlot + w.toSlot) / 2);
      if (mid > w.fromSlot && mid < w.toSlot) {
        openGaps.push({ fromSlot: w.fromSlot, toSlot: mid,    priority: w.samples.length + 1 });
        openGaps.push({ fromSlot: mid + 1,    toSlot: w.toSlot, priority: w.samples.length + 1 });
      }
    }

    // 2. Inter-window gaps — check continuity oracle
    for (let i = 0; i < windows.length - 1; i++) {
      const a = windows[i], b = windows[i + 1];
      const lastA  = a.samples.at(-1);
      const firstB = b.samples[0];
      if (!lastA || !firstB) continue;

      const gapFrom = lastA.slot + 1;
      const gapTo   = firstB.slot - 1;
      if (gapTo < gapFrom) continue;

      // Continuity oracle: matching post↔pre means flat gap, free prune
      if (strategy.useContinuityOracle && lastA.postLamports === firstB.preLamports) {
        resolvedByContinuity++;
        continue;
      }

      const delta = Math.abs(firstB.preLamports - lastA.postLamports);
      const priority = strategy.deltaWeightedFill
        ? Math.max(1, Math.log10(delta + 10))
        : 1;
      openGaps.push({ fromSlot: gapFrom, toSlot: gapTo, priority });
    }

    if (openGaps.length === 0) break;

    // Water-fill RPC budget by priority
    openGaps.sort((a, b) => b.priority - a.priority);
    const budget  = Math.max(0, strategy.maxRpcCalls - rpc.callCount());
    const toFetch = openGaps.slice(0, budget);
    if (toFetch.length === 0) break;

    const more = await Promise.all(
      toFetch.map(g => fetchWindow(rpc, address, g.fromSlot, g.toSlot, strategy.windowLimit, strategy, p))
    );
    rpcCalls += more.length;
    windows = [...windows, ...more].sort((a, b) => a.fromSlot - b.fromSlot);
  }

  // ── Stitch balance curve ───────────────────────────────────────────────────
  const allSamples = [];
  for (const w of windows) allSamples.push(...w.samples);

  const openGapsRemaining = windows.filter(w => w.truncated).length;

  return buildResult(
    address,
    allSamples,
    rpc.callCount(),
    performance.now() - t0,
    resolvedByContinuity,
    openGapsRemaining,
  );
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const _isCLI = process.argv[1] && new URL(import.meta.url).pathname === new URL(process.argv[1], 'file://').pathname;
const address = _isCLI ? process.argv[2] : null;
const apiKey  = _isCLI ? (process.argv[3] ?? process.env.HELIUS_API_KEY) : null;

if (address && apiKey) {
  console.log(`Fetching SOL balance for ${address}...`);
  const result = await solBalanceOverTime(address, apiKey);
  console.log(`\n${result.address}`);
  console.log("─".repeat(60));
  for (const p of result.points) {
    const sol  = (p.lamports / LAMPORTS_PER_SOL).toFixed(6);
    const kind = p.kind === "flat" ? " [flat]" : "";
    console.log(`slot ${String(p.slot).padStart(12)}  ${sol} SOL${kind}`);
  }
  console.log("─".repeat(60));
  console.log(`Opening: ${(result.openingLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Closing: ${(result.closingLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`Samples: ${result.stats.sampleCount}  |  Continuity pruned: ${result.stats.resolvedByContinuity}`);
  console.log(`Calls:   ${result.stats.totalRpcCalls}  |  ${result.stats.wallTimeMs.toFixed(0)}ms`);
}
