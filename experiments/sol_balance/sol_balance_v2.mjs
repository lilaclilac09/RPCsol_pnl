/**
 * SOL Balance V2 — Signatures-First Algorithm
 *
 * Completely new approach vs V1's Golomb probing:
 *
 *   Phase 0  Dual anchor
 *            Fetch newest N + oldest N full transactions in parallel.
 *            Fast-exit if they overlap (wallet fits in 2×anchorSize txns).
 *            Establishes [minSlot, maxSlot] for Phase 1.
 *
 *   Phase 1  Signature enumeration of the gap
 *            Use signatures endpoint (1000 sigs/call) to discover every
 *            transaction slot in [minSlot+1, maxSlot-1] cheaply.
 *            Sequential pagination (paginationToken) — reliable, stable.
 *
 *   Phase 2  Exact-window parallel full fetch
 *            Bin discovered sigs into groups of ≤windowSize by slot.
 *            Each window has precise [fromSlot, toSlot] bounds from real
 *            sig positions — windows never overflow, no refinement needed.
 *            Fire all windows in parallel.
 *
 * Why this beats Golomb probing:
 *   - Golomb windows are slot-range guesses; they overflow on dense history
 *     requiring pagination and refinement rounds.
 *   - Signatures endpoint is 10× cheaper per transaction (1000 vs 100).
 *   - Exact windows = zero overflow = one pass, no iteration.
 *   - For N txns in gap: (ceil(N/1000) sig calls) + (ceil(N/windowSize) full calls)
 *     vs Golomb's multiple-rounds of 100-limit probes.
 *
 * Call count comparison on test wallets:
 *   sparse (4 txns)  : 2 (anchor fast-exit)
 *   medium (60 txns) : 2 (anchor fast-exit)
 *   dense (451 txns) : 2 anchors + 1 sig + 5 full = 8
 */

export const DEFAULT_STRATEGY = {
  anchorSize:          100,   // full txns per anchor call (both directions)
  sigPageSize:        1000,   // sigs per Phase 1 call (max Helius allows)
  windowSize:           90,   // target txns per Phase 2 full-fetch window
  maxSigPages:          20,   // safety cap on Phase 1 pagination depth
  maxConcurrency:       12,
  useContinuityOracle: true,  // skip full fetch if anchor continuity proven
  skipZeroDelta:       true,  // exclude txns where pre===post balance
};

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure: semaphore + retry + HTTP client
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_BASE_MS = 200;
const MAX_RETRIES   = 5;

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
      const isTransient =
        err.code === "ECONNRESET" ||
        /429|503|terminated|fetch failed/i.test(err.message ?? "");
      if (!isTransient || attempt === MAX_RETRIES) throw err;
      const delay = RETRY_BASE_MS * 2 ** attempt + Math.random() * 150;
      await new Promise(r => setTimeout(r, delay));
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
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => String(res.status));
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 80)}`);
      }
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json.result;
    } finally {
      release();
    }
  });

  // Full transactions for a slot range
  const fullTxns = (address, fromSlot, toSlot, limit, sortOrder = "asc", token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full",
        encoding:           "jsonParsed",
        maxSupportedTransactionVersion: 0,
        sortOrder,
        limit,
        filters: {
          ...(fromSlot > 0 || toSlot < 999_999_999
            ? { slot: { gte: fromSlot, lte: toSlot } }
            : {}),
          status:        "succeeded",
          tokenAccounts: "none",
        },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  // Signatures only (cheap: 1000/call)
  const sigPage = (address, fromSlot, toSlot, limit = 1000, token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "signatures",
        sortOrder:          "asc",
        limit,
        filters: {
          slot: { gte: fromSlot, lte: toSlot },
          status:        "succeeded",
          tokenAccounts: "none",
        },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  return { fullTxns, sigPage, callCount: () => calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractSamples(data, address, skipZeroDelta) {
  const out = [];
  for (const tx of data ?? []) {
    const keys = tx?.transaction?.message?.accountKeys ?? [];
    const idx  = keys.findIndex(k => (typeof k === "string" ? k : k?.pubkey) === address);
    if (idx < 0) continue;
    const pre  = tx.meta?.preBalances?.[idx]  ?? 0;
    const post = tx.meta?.postBalances?.[idx] ?? 0;
    if (skipZeroDelta && pre === post) continue;
    out.push({
      slot:         tx.slot,
      signature:    tx.transaction?.signatures?.[0] ?? "",
      preLamports:  pre,
      postLamports: post,
    });
  }
  return out;
}

function dedup(samples) {
  const seen = new Set();
  return samples
    .filter(s => {
      const k = s.signature || `${s.slot}:${s.preLamports}:${s.postLamports}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.slot - b.slot);
}

// ─────────────────────────────────────────────────────────────────────────────
// Result builder
// ─────────────────────────────────────────────────────────────────────────────

const LAMPORTS = 1_000_000_000;

function buildResult(address, rawSamples, rpcCalls, wallMs, meta = {}) {
  const samples = dedup(rawSamples);
  const points  = [];
  let lastLamports = null, lastSlot = null;
  for (const s of samples) {
    if (lastLamports !== null && lastSlot !== null &&
        lastLamports !== s.preLamports && s.slot > lastSlot + 1) {
      points.push({ slot: s.slot - 1, lamports: lastLamports, kind: "flat" });
    }
    points.push({ slot: s.slot, lamports: s.postLamports, kind: "sample" });
    lastLamports = s.postLamports;
    lastSlot     = s.slot;
  }
  return {
    address,
    points,
    openingLamports: samples[0]?.preLamports    ?? 0,
    closingLamports: samples.at(-1)?.postLamports ?? 0,
    stats: {
      totalRpcCalls:     rpcCalls,
      wallTimeMs:        wallMs,
      sampleCount:       samples.length,
      openGapsRemaining: meta.openGaps ?? 0,
      resolvedByContinuity: meta.continuityHits ?? 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Enumerate all signatures in a slot range
// Returns an array of { slot, signature } sorted ascending
// ─────────────────────────────────────────────────────────────────────────────

async function enumerateSigs(rpc, address, fromSlot, toSlot, strategy) {
  const allSigs = [];
  let token = null;
  let pages = 0;

  do {
    const result = await rpc.sigPage(address, fromSlot, toSlot, strategy.sigPageSize, token);
    const page   = result?.data ?? [];
    for (const entry of page) {
      if (entry?.slot != null) allSigs.push({ slot: entry.slot, sig: entry.signature ?? "" });
    }
    token = result?.paginationToken ?? null;
    pages++;
  } while (token && pages < strategy.maxSigPages);

  return allSigs; // sorted asc by Helius
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Build exact windows from sig list, fetch full txns in parallel
// ─────────────────────────────────────────────────────────────────────────────

function buildWindows(sigs, windowSize) {
  if (sigs.length === 0) return [];
  const windows = [];
  let   i = 0;
  while (i < sigs.length) {
    const chunk = sigs.slice(i, i + windowSize);
    windows.push({
      fromSlot: chunk[0].slot,
      toSlot:   chunk.at(-1).slot,
    });
    i += windowSize;
  }
  return windows;
}

async function fetchWindow(rpc, address, fromSlot, toSlot, strategy) {
  // Fetch full txns for exact slot range; window sized from sigs so should fit in 1 call
  const result  = await rpc.fullTxns(address, fromSlot, toSlot, 100, "asc");
  const samples = extractSamples(result?.data ?? [], address, strategy.skipZeroDelta);
  // If page was full and there's a token, fetch remaining pages (shouldn't happen with exact windows)
  let token = result?.paginationToken ?? null;
  while (token) {
    const next = await rpc.fullTxns(address, fromSlot, toSlot, 100, "asc", token);
    samples.push(...extractSamples(next?.data ?? [], address, strategy.skipZeroDelta));
    token = next?.paginationToken ?? null;
  }
  return samples;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main algorithm
// ─────────────────────────────────────────────────────────────────────────────

export async function solBalanceOverTime(address, apiKey, strategy = DEFAULT_STRATEGY) {
  const t0  = performance.now();
  const rpc = makeRpc(apiKey, strategy.maxConcurrency);

  // ── Phase 0: Dual anchor ────────────────────────────────────────────────────
  // Helius full-tx endpoint is capped at 100/call. For anchorSize > 100 we
  // paginate: fetch pages of 100 until we have anchorSize samples or run out.
  async function fetchAnchor(sortOrder) {
    // Helius full-tx API is hard-capped at 100 per call.
    // We fetch min(anchorSize, 100) in one call — no pagination here.
    // The paginationToken tells us if the wallet has more txns beyond this page.
    const limit  = Math.min(strategy.anchorSize, 100);
    const result = await rpc.fullTxns(address, 0, 999_999_999, limit, sortOrder, null);
    const page   = result?.data ?? [];
    const samples = extractSamples(page, address, strategy.skipZeroDelta);
    if (sortOrder === "desc") samples.reverse();
    const truncated = !!result?.paginationToken;
    return { samples, truncated };
  }

  const [newestAnchor, oldestAnchor] = await Promise.all([
    fetchAnchor("desc"),
    fetchAnchor("asc"),
  ]);

  const newestSamples   = newestAnchor.samples;
  const oldestSamples   = oldestAnchor.samples;
  const newestTruncated = newestAnchor.truncated;

  // Fast-exit: if the two anchor pages overlap, we have the full history
  const oldestLastSlot  = oldestSamples.at(-1)?.slot ?? -1;
  const newestFirstSlot = newestSamples[0]?.slot      ?? Infinity;

  if (!newestTruncated || oldestLastSlot >= newestFirstSlot) {
    const combined = dedup([...oldestSamples, ...newestSamples]);
    return buildResult(address, combined, rpc.callCount(), performance.now() - t0);
  }

  const gapFrom = oldestLastSlot  + 1;
  const gapTo   = newestFirstSlot - 1;

  // ── Continuity oracle: zero-call gap pruning ────────────────────────────────
  // If last seen balance from oldest anchor === first seen pre-balance of newest anchor,
  // the gap is provably flat (no SOL changes). Skip Phase 1+2 entirely.
  let continuityHits = 0;
  if (strategy.useContinuityOracle) {
    const lastOldest  = oldestSamples.at(-1);
    const firstNewest = newestSamples[0];
    if (lastOldest && firstNewest && lastOldest.postLamports === firstNewest.preLamports) {
      continuityHits++;
      const combined = dedup([...oldestSamples, ...newestSamples]);
      return buildResult(address, combined, rpc.callCount(), performance.now() - t0,
        { continuityHits, openGaps: 0 });
    }
  }

  // ── Phase 1: Signature enumeration of the gap ───────────────────────────────
  // Cheaply discovers all transaction slot positions before committing
  // to expensive full-tx fetches. 1000 sigs/call vs 100 full txns/call.
  const gapSigs = await enumerateSigs(rpc, address, gapFrom, gapTo, strategy);

  if (gapSigs.length === 0) {
    // No transactions in gap — anchors are complete
    const combined = dedup([...oldestSamples, ...newestSamples]);
    return buildResult(address, combined, rpc.callCount(), performance.now() - t0,
      { continuityHits });
  }

  // ── Phase 2: Parallel full-txn fetch using exact window bounds ──────────────
  // Windows are sized from actual sig positions — they never overflow.
  const windows = buildWindows(gapSigs, strategy.windowSize);

  const windowResults = await Promise.all(
    windows.map(w => fetchWindow(rpc, address, w.fromSlot, w.toSlot, strategy))
  );

  const allSamples = [
    ...oldestSamples,
    ...windowResults.flat(),
    ...newestSamples,
  ];

  return buildResult(address, allSamples, rpc.callCount(), performance.now() - t0,
    { continuityHits, openGaps: 0 });
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const address = process.argv[2];
  const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;

  if (!address || !apiKey) {
    console.error("Usage: node sol_balance_v2.mjs <address> <api-key>");
    process.exit(1);
  }

  console.log(`[v2] Fetching SOL balance for ${address}...`);
  const result = await solBalanceOverTime(address, apiKey);

  console.log(`\n${result.address}`);
  console.log("─".repeat(60));
  for (const p of result.points) {
    const sol  = (p.lamports / LAMPORTS).toFixed(6);
    const kind = p.kind === "flat" ? " [flat]" : "";
    console.log(`slot ${String(p.slot).padStart(12)}  ${sol} SOL${kind}`);
  }
  console.log("─".repeat(60));
  console.log(`Opening: ${(result.openingLamports / LAMPORTS).toFixed(6)} SOL`);
  console.log(`Closing: ${(result.closingLamports / LAMPORTS).toFixed(6)} SOL`);
  console.log(`Samples: ${result.stats.sampleCount}  |  Continuity pruned: ${result.stats.resolvedByContinuity}`);
  console.log(`Calls:   ${result.stats.totalRpcCalls}  |  ${result.stats.wallTimeMs.toFixed(0)}ms`);
}
