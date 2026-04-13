/**
 * SOL Balance V12 — Dual Anchor
 *
 * New over V11: fire anchorAsc(100) + anchorDesc(100) + sigPage(1000) all at once.
 *
 * Fast-exit cases (small/medium wallets):
 *   Case 1 — asc anchor covers everything  (≤100 txns):   1 RT, 3 calls
 *   Case 2 — asc+desc together cover all   (101–200 txns): 1 RT, 3 calls (NEW)
 *   Case 3 — gap windows needed            (>200 txns):    2 RTs, but gap is smaller
 *              asc/desc anchors cover outer 200 txns → fewer gap windows needed
 *
 * For the dense test wallet (~450 txns): gap shrinks from all 450 → ~250 middle txns
 * → fewer paginated window calls → lower dense wallet latency.
 *
 * Large wallets (>sigPageSize txns): V4 density probe path (same as V11).
 */

export const DEFAULT_STRATEGY = {
  sigPageSize:    1000,
  windowSize:       80,
  windowTarget:     80,
  maxSigPages:      20,
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

  const btFilter = (tStart, tEnd) => ({
    blockTime: { gte: tStart, lte: tEnd },
  });

  const fullTxns = (address, fromSlot, toSlot, limit, sortOrder = "asc", token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        sortOrder, limit,
        filters: {
          ...slotFilter(fromSlot, toSlot),
          status: "succeeded", tokenAccounts: "none",
        },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  const fullBt = (address, tStart, tEnd, limit, sortOrder = "asc", token = null) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "full",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        sortOrder, limit,
        filters: { ...btFilter(tStart, tEnd), status: "succeeded", tokenAccounts: "none" },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

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

  const sigProbe = (address, tStart, tEnd, limit) =>
    post({
      jsonrpc: "2.0", id: calls + 1,
      method: "getTransactionsForAddress",
      params: [address, {
        transactionDetails: "signatures",
        sortOrder: "asc", limit,
        filters: { ...btFilter(tStart, tEnd), status: "succeeded" },
      }],
    });

  return { fullTxns, fullBt, sigPage, sigProbe, callCount: () => calls };
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
    out.push({ slot: tx.slot, signature: tx.transaction?.signatures?.[0] ?? "",
               preLamports: pre, postLamports: post });
  }
  return out;
}

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

function buildSlotWindows(sigsAsc, windowSize) {
  const windows = [];
  for (let i = 0; i < sigsAsc.length; i += windowSize)
    windows.push({
      fromSlot: sigsAsc[i].slot,
      toSlot:   sigsAsc[Math.min(i + windowSize - 1, sigsAsc.length - 1)].slot,
    });
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
// Main
// ─────────────────────────────────────────────────────────────────────────────

export async function solBalanceOverTime(address, apiKey, strategy = DEFAULT_STRATEGY) {
  const t0  = performance.now();
  const rpc = makeRpc(apiKey, strategy.maxConcurrency);
  const ANCHOR_LIMIT = 100;

  // ── Phase 0: fire 3 calls simultaneously ─────────────────────────────────
  const anchorAscPromise  = rpc.fullTxns(address, 0, 999_999_999, ANCHOR_LIMIT, "asc");
  const anchorDescPromise = rpc.fullTxns(address, 0, 999_999_999, ANCHOR_LIMIT, "desc");
  const sigsPromise       = rpc.sigPage(address,  0, 999_999_999, "desc", strategy.sigPageSize);

  // Await sigs first — smallest payload, arrives soonest
  const newestSigs    = await sigsPromise;
  const allSigsDesc   = newestSigs?.data ?? [];
  const sigsTruncated = !!newestSigs?.paginationToken && allSigsDesc.length >= strategy.sigPageSize;

  // ── Large wallet (>sigPageSize txns): V4 density probe path ──────────────
  if (sigsTruncated) {
    const anchorAscRaw = await anchorAscPromise;
    anchorDescPromise.catch(() => {}); // running in background — let it finish, discard result
    const anchorData    = anchorAscRaw?.data ?? [];
    const oldestSamples = extractSamples(anchorData, address, strategy.skipZeroDelta);

    const tMin         = anchorData[0]?.blockTime            ?? 0;
    const tMax         = allSigsDesc[0]?.blockTime           ?? Math.floor(Date.now() / 1000);
    const tAfterOldest = (anchorData.at(-1)?.blockTime ?? tMin) + 1;
    const tBefNewest   = allSigsDesc.at(-1)?.blockTime       ?? tMax;

    if (tAfterOldest >= tBefNewest) {
      const newestFull    = await rpc.fullTxns(address, 0, 999_999_999, ANCHOR_LIMIT, "desc");
      const newestSamples = extractSamples(newestFull?.data ?? [], address, strategy.skipZeroDelta);
      return buildResult(address, [...oldestSamples, ...newestSamples], rpc.callCount(), performance.now() - t0);
    }

    const probe     = await rpc.sigProbe(address, tAfterOldest, tBefNewest, 1000);
    const probeSigs = probe?.data ?? [];

    let windows;
    if (!probe?.paginationToken) {
      windows = [];
      for (let i = 0; i < probeSigs.length; i += strategy.windowSize) {
        const chunk = probeSigs.slice(i, i + strategy.windowSize);
        const next  = probeSigs[i + strategy.windowSize];
        windows.push({ tStart: chunk[0].blockTime, tEnd: next ? next.blockTime : chunk.at(-1).blockTime + 1 });
      }
    } else {
      const tProbeEnd = probeSigs.at(-1)?.blockTime ?? tBefNewest;
      const dOldest   = 100  / Math.max(1, tAfterOldest - tMin);
      const dNewest   = 100  / Math.max(1, tMax - tBefNewest);
      const dProbe    = 1000 / Math.max(1, tProbeEnd - tAfterOldest);
      windows = buildDensityWindows(tAfterOldest, tBefNewest,
                  Math.max(dOldest, dNewest, dProbe), strategy.windowTarget ?? 80);
    }

    const gapSamples = (await Promise.all(
      windows.map(w => fetchBtWindow(rpc, address, w.tStart, w.tEnd, strategy))
    )).flat();
    return buildResult(address, [...oldestSamples, ...gapSamples], rpc.callCount(), performance.now() - t0);
  }

  // ── Small/medium wallet (all sigs on one page) ────────────────────────────
  //
  // Build ascending sig list (in-place reverse, no spread copy)
  const n       = allSigsDesc.length;
  const allSigs = new Array(n);
  for (let i = 0; i < n; i++) allSigs[i] = { slot: allSigsDesc[n - 1 - i].slot };

  // Streaming: fire ALL window promises before awaiting anchors.
  // When anchors return we may fast-exit (Cases 1/2) — windows run in background.
  // If not, windows have been running the whole time → minimal extra wait.
  const windowPromises = n > 0
    ? buildSlotWindows(allSigs, strategy.windowSize).map(w =>
        fetchSlotWindow(rpc, address, w.fromSlot, w.toSlot, strategy))
    : [];

  // Await both anchors (smaller payload than window data, arrive sooner)
  const [anchorAscRaw, anchorDescRaw] = await Promise.all([anchorAscPromise, anchorDescPromise]);

  const anchorAscData  = anchorAscRaw?.data  ?? [];
  const anchorDescData = anchorDescRaw?.data ?? [];  // desc order: [0]=newest, at(-1)=oldest
  const anchorAscSamples  = extractSamples(anchorAscData,  address, strategy.skipZeroDelta);
  const anchorDescSamples = extractSamples(anchorDescData, address, strategy.skipZeroDelta);

  const anchorAscNewest  = anchorAscData.at(-1)?.slot  ?? -1;   // newest slot in asc anchor
  const anchorDescOldest = anchorDescData.at(-1)?.slot ?? Infinity; // oldest slot in desc anchor (last in desc)
  const sigsNewestSlot   = allSigsDesc[0]?.slot        ??  0;

  // ── CASE 1: asc anchor covers all transactions (≤100 txns) ───────────────
  if (anchorAscNewest >= sigsNewestSlot) {
    return buildResult(address, anchorAscSamples, rpc.callCount(), performance.now() - t0);
  }

  // ── CASE 2: asc+desc together cover all transactions (101–200 txns) ──────
  // asc anchor: oldest 100 txns. desc anchor: newest 100 txns.
  // If their slot ranges overlap or meet → no gap → complete coverage.
  if (anchorAscNewest >= anchorDescOldest) {
    const combined = [...anchorAscSamples, ...anchorDescSamples];
    return buildResult(address, combined, rpc.callCount(), performance.now() - t0);
  }

  // ── CASE 3: gap exists (>200 txns) — windows already running ─────────────
  // Anchors cover outermost 200 txns. Windows fill the gap and the overlap
  // (dedup handles it). Both anchor + window sets are merged and deduped.
  const windowResults = await Promise.all(windowPromises);
  const acc = [...anchorAscSamples];
  for (const w of windowResults) acc.push(...w);
  acc.push(...anchorDescSamples);
  return buildResult(address, acc, rpc.callCount(), performance.now() - t0);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const address = process.argv[2];
  const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;
  if (!address || !apiKey) { console.error("Usage: node sol_balance_v12.mjs <address> <api-key>"); process.exit(1); }
  const result = await solBalanceOverTime(address, apiKey);
  console.log(`\n${result.address}`);
  console.log("─".repeat(60));
  for (const p of result.points)
    console.log(`slot ${String(p.slot).padStart(12)}  ${(p.lamports / LAMPORTS).toFixed(6)} SOL${p.kind === "flat" ? " [flat]" : ""}`);
  console.log("─".repeat(60));
  console.log(`Samples: ${result.stats.sampleCount}  Calls: ${result.stats.totalRpcCalls}  ${result.stats.wallTimeMs.toFixed(0)}ms`);
}
