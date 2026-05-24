/**
 * SOL Balance V14 — Phantom-Token Fix (V11 + pagination guard)
 *
 * Builds on V11 (Hybrid Ultra) with one critical bug fix:
 *
 * BUG (V11): Helius returns paginationToken even when result count < limit.
 * This "phantom token" caused fetchSlotWindow and fetchBtWindow to fire a second
 * unnecessary API call per window (returning empty data). For the dense wallet
 * (451 txns, ~6 windows), this doubled the call count (6→12) and wall time (1.5s→3s+).
 *
 * FIX: Before the pagination while-loop, check result.data.length < limit.
 * If fewer results than limit, there is no real next page — skip the phantom token.
 * Same guard applied to fetchBtWindow.
 *
 * Expected impact: dense wallet window calls halved (12→6), wall time ~1000ms.
 * All wallets should now reliably complete under 2s with appropriate config.
 *
 * Architecture (unchanged from V11):
 *   Wallet ≤100 txns   → 1 RT  (anchor fast-exit)
 *   Wallet ≤1000 txns  → 2 RTs (streaming sigs + parallel exact windows)
 *   Wallet >1000 txns  → 2 RTs (Phase 0 + density probe Phase 1)
 */

export const DEFAULT_STRATEGY = {
  sigPageSize:    1000,
  windowSize:       80,   // slot-based windows (Cases 2/3)
  windowTarget:     80,   // blockTime-based windows (Case 4 density path)
  maxConcurrency:   16,
  skipZeroDelta:  false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure
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

  const slotFilter = (from, to) => {
    const f = {};
    if (from > 0)          f.gte = from;
    if (to < 999_999_999)  f.lte = to;
    return Object.keys(f).length ? { slot: f } : {};
  };

  const btFilter = (from, to) => {
    const f = {};
    if (from > 0)                          f.gte = from;
    if (to < Number.MAX_SAFE_INTEGER)      f.lt  = to;
    return Object.keys(f).length ? { blockTime: f } : {};
  };

  const fullTxns = (address, fromSlot, toSlot, limit, sortOrder = "asc", token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full", encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0, sortOrder, limit,
        filters: { ...slotFilter(fromSlot, toSlot), status: "succeeded", tokenAccounts: "none" },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  const sigPage = (address, fromSlot, toSlot, sortOrder = "desc", limit = 1000, token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "signatures", sortOrder, limit,
        filters: { ...slotFilter(fromSlot, toSlot), status: "succeeded" },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  // blockTime-based sig probe — V4's density path
  const sigProbe = (address, fromBt, toBt, limit = 1000) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "signatures", sortOrder: "asc", limit,
        filters: { ...btFilter(fromBt, toBt), status: "succeeded" },
      }],
    });

  const fullBt = (address, fromBt, toBt, limit, sortOrder = "asc", token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full", encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0, sortOrder, limit,
        filters: { ...btFilter(fromBt, toBt), status: "succeeded" },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  return { fullTxns, sigPage, sigProbe, fullBt, callCount: () => calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — memory-conscious (from V10)
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
               signature: tx.transaction?.signatures?.[0] ?? "",
               preLamports: pre, postLamports: post });
  }
  return out;
}

// Map-based dedup: O(1) per entry
function dedup(samples) {
  const seen = new Map();
  for (const s of samples) {
    const k = s.signature || `${s.slot}:${s.preLamports}:${s.postLamports}`;
    if (!seen.has(k)) seen.set(k, s);
  }
  return [...seen.values()].sort((a, b) => a.slot - b.slot);
}

const LAMPORTS = 1_000_000_000;

function buildResult(address, rawSamples, rpcCalls, wallMs) {
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
             openGapsRemaining: 0, resolvedByContinuity: 0 },
  };
}

function buildSlotWindows(sigs, windowSize) {
  const windows = [];
  for (let i = 0; i < sigs.length; i += windowSize)
    windows.push({ fromSlot: sigs[i].slot, toSlot: sigs[Math.min(i + windowSize - 1, sigs.length - 1)].slot });
  return windows;
}

function buildDensityWindows(tStart, tEnd, density, target) {
  const windowSecs = Math.max(1, Math.floor(target / density));
  const windows = [];
  for (let t = tStart; t < tEnd; t += windowSecs)
    windows.push({ tStart: t, tEnd: Math.min(t + windowSecs, tEnd) });
  return windows;
}

async function fetchSlotWindow(rpc, address, fromSlot, toSlot, strategy) {
  const LIMIT   = 100;
  const result  = await rpc.fullTxns(address, fromSlot, toSlot, LIMIT, "asc");
  const data    = result?.data ?? [];
  const samples = extractSamples(data, address, strategy.skipZeroDelta);
  // V14 fix: skip phantom paginationToken when result < limit — no real next page exists
  if (data.length < LIMIT) return samples;
  let token = result?.paginationToken ?? null;
  while (token) {
    const next     = await rpc.fullTxns(address, fromSlot, toSlot, LIMIT, "asc", token);
    const nextData = next?.data ?? [];
    samples.push(...extractSamples(nextData, address, strategy.skipZeroDelta));
    if (nextData.length < LIMIT) break; // phantom token on continuation page
    token = next?.paginationToken ?? null;
  }
  return samples;
}

async function fetchBtWindow(rpc, address, tStart, tEnd, strategy) {
  const LIMIT   = 100;
  const result  = await rpc.fullBt(address, tStart, tEnd, LIMIT, "asc");
  const data    = result?.data ?? [];
  const samples = extractSamples(data, address, strategy.skipZeroDelta);
  // V14 fix: skip phantom paginationToken when result < limit
  if (data.length < LIMIT) return samples;
  let token = result?.paginationToken ?? null;
  while (token) {
    const next     = await rpc.fullBt(address, tStart, tEnd, LIMIT, "asc", token);
    const nextData = next?.data ?? [];
    samples.push(...extractSamples(nextData, address, strategy.skipZeroDelta));
    if (nextData.length < LIMIT) break;
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
  const ANCHOR_LIMIT = 100; // fixed — maximises fast-exit hit rate

  // ── Phase 0: fire both simultaneously, await sigs first (streaming) ───────
  const anchorPromise = rpc.fullTxns(address, 0, 999_999_999, ANCHOR_LIMIT, "asc");
  const sigsPromise   = rpc.sigPage(address,  0, 999_999_999, "desc", strategy.sigPageSize);

  const newestSigs    = await sigsPromise;
  const allSigsDesc   = newestSigs?.data ?? [];
  const sigsTruncated = !!newestSigs?.paginationToken && allSigsDesc.length >= strategy.sigPageSize;

  // ── Case 4: large wallet (>sigPageSize txns) — V4 density probe path ──────
  // Don't fire slot windows speculatively — we need anchor first to get blockTimes.
  if (sigsTruncated) {
    const anchorRaw     = await anchorPromise;
    const anchorData    = anchorRaw?.data ?? [];
    const oldestSamples = extractSamples(anchorData, address, strategy.skipZeroDelta);

    const tMin          = anchorData[0]?.blockTime            ?? 0;
    const tMax          = allSigsDesc[0]?.blockTime           ?? Math.floor(Date.now() / 1000);
    const tAfterOldest  = (anchorData.at(-1)?.blockTime ?? tMin) + 1;
    const tBeforeNewest = allSigsDesc.at(-1)?.blockTime       ?? tMax;

    if (tAfterOldest >= tBeforeNewest) {
      const newestFull    = await rpc.fullTxns(address, 0, 999_999_999, ANCHOR_LIMIT, "desc");
      const newestSamples = extractSamples(newestFull?.data ?? [], address, strategy.skipZeroDelta);
      return buildResult(address, [...oldestSamples, ...newestSamples], rpc.callCount(), performance.now() - t0);
    }

    // Single density probe for the gap
    const probe     = await rpc.sigProbe(address, tAfterOldest, tBeforeNewest, 1000);
    const probeSigs = probe?.data ?? [];

    let windows;
    if (!probe?.paginationToken) {
      windows = [];
      for (let i = 0; i < probeSigs.length; i += strategy.windowSize) {
        const chunk  = probeSigs.slice(i, i + strategy.windowSize);
        const tStart = chunk[0].blockTime;
        const next   = probeSigs[i + strategy.windowSize];
        windows.push({ tStart, tEnd: next ? next.blockTime : chunk.at(-1).blockTime + 1 });
      }
    } else {
      const tProbeEnd = probeSigs.at(-1)?.blockTime ?? tBeforeNewest;
      const dOldest   = 100  / Math.max(1, tAfterOldest  - tMin);
      const dNewest   = 100  / Math.max(1, tMax - tBeforeNewest);
      const dProbe    = 1000 / Math.max(1, tProbeEnd - tAfterOldest);
      windows = buildDensityWindows(tAfterOldest, tBeforeNewest,
                  Math.max(dOldest, dNewest, dProbe), strategy.windowTarget ?? 80);
    }

    const gapSamples = (await Promise.all(
      windows.map(w => fetchBtWindow(rpc, address, w.tStart, w.tEnd, strategy))
    )).flat();
    return buildResult(address, [...oldestSamples, ...gapSamples], rpc.callCount(), performance.now() - t0);
  }

  // ── Cases 1-3: small/medium wallet (all sigs on one page) — V10 streaming ─
  //
  // In-place reverse: avoid spread copy
  const n       = allSigsDesc.length;
  const allSigs = new Array(n);
  for (let i = 0; i < n; i++) allSigs[i] = { slot: allSigsDesc[n - 1 - i].slot };

  // Streaming: fire window promises NOW before anchor returns
  const windowPromises = n > 0
    ? buildSlotWindows(allSigs, strategy.windowSize).map(w =>
        fetchSlotWindow(rpc, address, w.fromSlot, w.toSlot, strategy))
    : [];

  // Await anchor (may already be done)
  const anchorRaw     = await anchorPromise;
  const anchorData    = anchorRaw?.data ?? [];
  const anchorSamples = extractSamples(anchorData, address, strategy.skipZeroDelta);

  // ── FAST EXIT: anchor covers all sigs → 1 serial RT ──────────────────────
  const anchorNewestSlot = anchorData.at(-1)?.slot ?? -1;
  const sigsNewestSlot   = allSigsDesc[0]?.slot    ??  0;

  if (anchorNewestSlot >= sigsNewestSlot) {
    // Window promises run in background; results discarded by GC
    return buildResult(address, anchorSamples, rpc.callCount(), performance.now() - t0);
  }

  // Await windows, push directly to accumulator (no intermediate .flat())
  const windowResults = await Promise.all(windowPromises);
  const acc = [...anchorSamples];
  for (const w of windowResults) acc.push(...w);
  return buildResult(address, acc, rpc.callCount(), performance.now() - t0);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const address = process.argv[2];
  const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;
  if (!address || !apiKey) { console.error("Usage: node sol_balance_v14.mjs <address> <api-key>"); process.exit(1); }
  const result = await solBalanceOverTime(address, apiKey);
  console.log(`\n${result.address}`);
  console.log("─".repeat(60));
  for (const p of result.points)
    console.log(`slot ${String(p.slot).padStart(12)}  ${(p.lamports / LAMPORTS).toFixed(6)} SOL${p.kind === "flat" ? " [flat]" : ""}`);
  console.log("─".repeat(60));
  console.log(`Samples: ${result.stats.sampleCount}  Calls: ${result.stats.totalRpcCalls}  ${result.stats.wallTimeMs.toFixed(0)}ms`);
}
