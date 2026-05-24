/**
 * SOL Balance V4 — Hybrid: Merged-anchor + single-probe density fallback
 *
 * Combines V3's parallel Phase 0 with the Codex variant's single-probe density
 * approach for large (>sigPageSize) wallets. Result: always 2 serial round-trips,
 * regardless of wallet size.
 *
 * V3 weakness: wallets with >1000 transactions fall into sequential sig pagination
 * (potentially many serial round-trips).
 *
 * V4 fix: for the >1000 sig case, use ONE blockTime-based density probe instead
 * of paginating signatures. Density is estimated from 3 measurements:
 *   d_oldest = 100 / (end of oldest anchor - wallet start)
 *   d_newest = 100 / (wallet end - start of newest anchor)
 *   d_probe  = 1000 / (blockTime span of probe page)
 * Take the max (conservative) to avoid window overflow.
 *
 * Phase 0 (1 round-trip, always):
 *   [oldest full txns] + [newest signatures] in parallel
 *
 * Phase 1 (1 round-trip, parallel windows):
 *   TINY:   anchor covers everything → done (0 Phase 1 calls)
 *   SPARSE: ≤ sigPageSize sigs, no overlap → exact sig windows
 *   DENSE:  > sigPageSize sigs → ONE density probe → blockTime windows
 *
 * Total: 2 serial round-trips in all cases. Never sequential sig pagination.
 */

export const DEFAULT_STRATEGY = {
  anchorSize:     100,   // full txns in oldest anchor (capped at 100 by API)
  sigPageSize:    1000,  // sigs per discovery call
  windowSize:      80,   // target txns per full-fetch window (sparse path)
  windowTarget:    80,   // target txns per window (dense path)
  maxConcurrency:   8,
  skipZeroDelta:  true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure (same as V3)
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
      const transient = err.code === "ECONNRESET" ||
        /429|503|terminated|fetch failed/i.test(err.message ?? "");
      if (!transient || attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * 2 ** attempt + Math.random() * 150));
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
      if (!res.ok) {
        const txt = await res.text().catch(() => String(res.status));
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 80)}`);
      }
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json.result;
    } finally { release(); }
  });

  // Slot-based: only add gte/lte when actually constrained (avoids gte:0 error)
  const slotFilter = (from, to) => {
    const f = {};
    if (from > 0)         f.gte = from;
    if (to < 999_999_999) f.lte = to;
    return Object.keys(f).length ? { slot: f } : {};
  };

  // blockTime filter: used by the density probe path
  const btFilter = (from, to) => {
    const f = {};
    if (from > 0)             f.gte = from;
    if (to < Number.MAX_SAFE_INTEGER) f.lt = to;
    return Object.keys(f).length ? { blockTime: f } : {};
  };

  const fullTxns = (address, fromSlot, toSlot, limit, sortOrder = "asc", token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        sortOrder, limit,
        filters: { ...slotFilter(fromSlot, toSlot), status: "succeeded", tokenAccounts: "none" },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  // Slot-based sig page (used for Phase 0 newest sigs)
  const sigPage = (address, fromSlot, toSlot, sortOrder = "desc", limit = 1000, token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "signatures",
        sortOrder, limit,
        filters: { ...slotFilter(fromSlot, toSlot), status: "succeeded" },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  // blockTime-based sig page (used for dense path density probe)
  const sigProbe = (address, fromBt, toBt, limit = 1000) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "signatures",
        sortOrder: "asc", limit,
        filters: { ...btFilter(fromBt, toBt), status: "succeeded" },
      }],
    });

  // blockTime-based full window fetch (used for dense path Phase 1)
  const fullBt = (address, fromBt, toBt, limit, sortOrder = "asc", token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        sortOrder, limit,
        filters: { ...btFilter(fromBt, toBt), status: "succeeded" },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  return { fullTxns, sigPage, sigProbe, fullBt, callCount: () => calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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
    out.push({ slot: tx.slot, blockTime: tx.blockTime ?? 0,
               signature: tx.transaction?.signatures?.[0] ?? "", preLamports: pre, postLamports: post });
  }
  return out;
}

function dedup(samples) {
  const seen = new Set();
  return samples
    .filter(s => { const k = s.signature || `${s.slot}:${s.preLamports}:${s.postLamports}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.slot - b.slot);
}

const LAMPORTS = 1_000_000_000;

function buildResult(address, rawSamples, rpcCalls, wallMs) {
  const samples = dedup(rawSamples);
  const points  = [];
  let lastLamports = null, lastSlot = null;
  for (const s of samples) {
    if (lastLamports !== null && lastSlot !== null && lastLamports !== s.preLamports && s.slot > lastSlot + 1)
      points.push({ slot: s.slot - 1, lamports: lastLamports, kind: "flat" });
    points.push({ slot: s.slot, lamports: s.postLamports, kind: "sample" });
    lastLamports = s.postLamports; lastSlot = s.slot;
  }
  return {
    address, points,
    openingLamports: samples[0]?.preLamports    ?? 0,
    closingLamports: samples.at(-1)?.postLamports ?? 0,
    stats: { totalRpcCalls: rpcCalls, wallTimeMs: wallMs, sampleCount: samples.length,
             openGapsRemaining: 0, resolvedByContinuity: 0 },
  };
}

// Slot-based windows from sig list
function buildSlotWindows(sigs, windowSize) {
  const windows = [];
  for (let i = 0; i < sigs.length; i += windowSize)
    windows.push({ fromSlot: sigs[i].slot, toSlot: sigs[Math.min(i + windowSize - 1, sigs.length - 1)].slot });
  return windows;
}

// blockTime-based windows from density estimate
function buildDensityWindows(tStart, tEnd, density, target) {
  const windowSecs = Math.max(1, Math.floor(target / density));
  const windows = [];
  for (let t = tStart; t < tEnd; t += windowSecs)
    windows.push({ tStart: t, tEnd: Math.min(t + windowSecs, tEnd) });
  return windows;
}

// Fetch one slot-range window
async function fetchSlotWindow(rpc, address, fromSlot, toSlot, strategy) {
  const result  = await rpc.fullTxns(address, fromSlot, toSlot, 100, "asc");
  const samples = extractSamples(result?.data ?? [], address, strategy.skipZeroDelta);
  let token = result?.paginationToken ?? null;
  while (token) {
    const next = await rpc.fullTxns(address, fromSlot, toSlot, 100, "asc", token);
    samples.push(...extractSamples(next?.data ?? [], address, strategy.skipZeroDelta));
    token = next?.paginationToken ?? null;
  }
  return samples;
}

// Fetch one blockTime window
async function fetchBtWindow(rpc, address, tStart, tEnd, strategy) {
  const result  = await rpc.fullBt(address, tStart, tEnd, 100, "asc");
  const samples = extractSamples(result?.data ?? [], address, strategy.skipZeroDelta);
  let token = result?.paginationToken ?? null;
  while (token) {
    const next = await rpc.fullBt(address, tStart, tEnd, 100, "asc", token);
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

  const anchorLimit = Math.min(strategy.anchorSize, 100);

  // ── Phase 0: One parallel round-trip — oldest full + newest sigs ──────────
  const [oldestRaw, newestSigs] = await Promise.all([
    rpc.fullTxns(address, 0, 999_999_999, anchorLimit, "asc"),
    rpc.sigPage(address, 0, 999_999_999, "desc", strategy.sigPageSize),
  ]);

  const oldestSamples = extractSamples(oldestRaw?.data ?? [], address, strategy.skipZeroDelta);
  const allSigsDesc   = newestSigs?.data ?? [];
  // Helius sometimes returns paginationToken even for < limit results; treat as
  // truncated only when we actually hit the page limit.
  const sigsTruncated = !!newestSigs?.paginationToken && allSigsDesc.length >= strategy.sigPageSize;

  let allSigs = [...allSigsDesc].reverse().map(s => ({ slot: s.slot, sig: s.signature ?? "" }));

  const oldestLastSlot  = oldestSamples.at(-1)?.slot ?? -1;
  const oldestLastBt    = oldestSamples.at(-1)?.blockTime ?? -1;
  const newestFirstSlot = allSigs[0]?.slot ?? Infinity;

  // Case 1: anchor covers entire wallet
  if (!oldestRaw?.paginationToken && allSigs.length <= oldestSamples.length)
    return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);

  // Case 2: sigs complete + anchor overlaps → no gap
  if (!sigsTruncated && oldestLastSlot >= newestFirstSlot) {
    const gapSigs = allSigs.filter(s => s.slot > oldestLastSlot);
    if (gapSigs.length === 0)
      return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);
    const windows = buildSlotWindows(gapSigs, strategy.windowSize);
    const fetched = await Promise.all(windows.map(w => fetchSlotWindow(rpc, address, w.fromSlot, w.toSlot, strategy)));
    return buildResult(address, [...oldestSamples, ...fetched.flat()], rpc.callCount(), performance.now() - t0);
  }

  // Case 3: sigs complete (≤ sigPageSize total) → exact slot windows
  if (!sigsTruncated) {
    const gapSigs = allSigs.filter(s => s.slot > oldestLastSlot);
    if (gapSigs.length === 0)
      return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);
    const windows = buildSlotWindows(gapSigs, strategy.windowSize);
    const fetched = await Promise.all(windows.map(w => fetchSlotWindow(rpc, address, w.fromSlot, w.toSlot, strategy)));
    return buildResult(address, [...oldestSamples, ...fetched.flat()], rpc.callCount(), performance.now() - t0);
  }

  // Case 4: DENSE (> sigPageSize sigs) — single blockTime density probe
  // Use the anchor blockTimes to bound the gap, then one sig probe for density.
  const newestData     = newestSigs?.data ?? [];
  const tMin           = oldestRaw?.data?.[0]?.blockTime          ?? 0;
  const tMax           = newestData?.[0]?.blockTime               ?? Math.floor(Date.now() / 1000);
  const tAfterOldest   = (oldestRaw?.data?.at(-1)?.blockTime ?? tMin) + 1;
  const tBeforeNewest  = newestData?.at(-1)?.blockTime ?? tMax;

  if (tAfterOldest >= tBeforeNewest) {
    // Anchors overlap in time — merge and return
    const newestSamples = extractSamples(
      await rpc.fullTxns(address, 0, 999_999_999, anchorLimit, "desc").then(r => r?.data ?? []),
      address, strategy.skipZeroDelta
    );
    return buildResult(address, [...oldestSamples, ...newestSamples], rpc.callCount(), performance.now() - t0);
  }

  // Single density probe for the gap
  const probe = await rpc.sigProbe(address, tAfterOldest, tBeforeNewest, 1000);
  const probeSigs = probe?.data ?? [];

  let windows;
  if (!probe?.paginationToken) {
    // Gap has < 1000 sigs — exact windows from sig blockTimes
    windows = [];
    for (let i = 0; i < probeSigs.length; i += strategy.windowSize) {
      const chunk  = probeSigs.slice(i, i + strategy.windowSize);
      const tStart = chunk[0].blockTime;
      const next   = probeSigs[i + strategy.windowSize];
      const tEnd   = next ? next.blockTime : chunk.at(-1).blockTime + 1;
      windows.push({ tStart, tEnd, kind: "bt" });
    }
  } else {
    // Gap has ≥ 1000 sigs — density estimate from 3 sources
    const tProbeEnd = probeSigs.at(-1)?.blockTime ?? tBeforeNewest;
    const dOldest   = 100  / Math.max(1, tAfterOldest  - tMin);
    const dNewest   = 100  / Math.max(1, tMax - tBeforeNewest);
    const dProbe    = 1000 / Math.max(1, tProbeEnd - tAfterOldest);
    const density   = Math.max(dOldest, dNewest, dProbe);
    const bt        = buildDensityWindows(tAfterOldest, tBeforeNewest, density, strategy.windowTarget ?? 80);
    windows         = bt.map(w => ({ ...w, kind: "bt" }));
  }

  // Phase 1: fetch all gap windows in parallel (blockTime-based)
  const gapSamples = (await Promise.all(
    windows.map(w => fetchBtWindow(rpc, address, w.tStart, w.tEnd, strategy))
  )).flat();

  return buildResult(address, [...oldestSamples, ...gapSamples], rpc.callCount(), performance.now() - t0);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const address = process.argv[2];
  const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;
  if (!address || !apiKey) { console.error("Usage: node sol_balance_v4.mjs <address> <api-key>"); process.exit(1); }
  console.log(`[v4] Fetching SOL balance for ${address}...`);
  const result = await solBalanceOverTime(address, apiKey);
  console.log(`\n${result.address}`);
  console.log("─".repeat(60));
  for (const p of result.points) {
    const sol = (p.lamports / LAMPORTS).toFixed(6);
    console.log(`slot ${String(p.slot).padStart(12)}  ${sol} SOL${p.kind === "flat" ? " [flat]" : ""}`);
  }
  console.log("─".repeat(60));
  console.log(`Samples: ${result.stats.sampleCount}  Calls: ${result.stats.totalRpcCalls}  ${result.stats.wallTimeMs.toFixed(0)}ms`);
}
