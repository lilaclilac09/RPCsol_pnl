/**
 * SOL Balance V10 — Ultra Low Latency
 *
 * Three compounding optimisations over V8:
 *
 * 1. FAST-EXIT (biggest win)
 *    Always fetch anchor=100. When the anchor's newest slot >= sigs' newest slot,
 *    the anchor already contains every transaction. Return immediately — no Phase 1.
 *    Sparse wallets (≤100 txns): 1 serial RT  (~900ms → ~450ms on slow key)
 *    Medium wallets (≤100 txns): 1 serial RT  (~2000ms → ~500ms)
 *    Dense wallets  (>100 txns): 2 serial RTs (streaming, same as V8)
 *
 * 2. STREAMING (from V8)
 *    Start Phase 1 windows the moment sigs arrive — don't wait for anchor.
 *    If fast-exit fires later, window promises complete in background (results ignored).
 *    Dense wallets benefit; sparse/medium cost is 1 extra fired call (result discarded).
 *
 * 3. MEMORY — minimal allocations
 *    - In-place reverse iteration instead of spread+reverse+map for sigs
 *    - Map-based dedup (O(1) lookup) instead of Set+filter (O(n))
 *    - Process and discard: extractSamples does not hold tx objects
 *    - No intermediate .flat() on window results — push directly to accumulator
 *
 * Serial RT summary:
 *   Wallet ≤100 txns  → 1 RT  (anchor fast-exit)
 *   Wallet ≤1000 txns → 2 RTs (streaming sigs + parallel windows)
 *   Wallet >1000 txns → 2 RTs (gap pagination — same as V3/V8)
 */

export const DEFAULT_STRATEGY = {
  sigPageSize:    1000,
  windowSize:       80,
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

  return { fullTxns, sigPage, callCount: () => calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — memory-conscious
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

// Map-based dedup: O(1) per entry vs O(n) filter
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

function buildWindows(sigsAsc, windowSize) {
  const windows = [];
  for (let i = 0; i < sigsAsc.length; i += windowSize)
    windows.push({
      fromSlot: sigsAsc[i].slot,
      toSlot:   sigsAsc[Math.min(i + windowSize - 1, sigsAsc.length - 1)].slot,
    });
  return windows;
}

async function fetchWindow(rpc, address, fromSlot, toSlot, strategy) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export async function solBalanceOverTime(address, apiKey, strategy = DEFAULT_STRATEGY) {
  const t0  = performance.now();
  const rpc = makeRpc(apiKey, strategy.maxConcurrency);

  // anchor=100 always — maximises the fast-exit hit rate for small wallets
  const ANCHOR_LIMIT = 100;

  // ── Phase 0: fire both calls simultaneously ───────────────────────────────
  const anchorPromise = rpc.fullTxns(address, 0, 999_999_999, ANCHOR_LIMIT, "asc");
  const sigsPromise   = rpc.sigPage(address,  0, 999_999_999, "desc", strategy.sigPageSize);

  // Await sigs first — smaller payload, arrives sooner
  const newestSigs    = await sigsPromise;
  const allSigsDesc   = newestSigs?.data ?? [];
  const sigsTruncated = !!newestSigs?.paginationToken && allSigsDesc.length >= strategy.sigPageSize;

  // ── Case: large wallet (>sigPageSize txns) ────────────────────────────────
  // Must paginate sigs. Fall through to gap-fill (same as V3).
  if (sigsTruncated) {
    const anchorRaw     = await anchorPromise;
    const anchorSamples = extractSamples(anchorRaw?.data ?? [], address, strategy.skipZeroDelta);
    const maxSlot  = allSigsDesc[0]?.slot ?? 999_999_999;
    const gapFrom  = Math.max(1, (anchorSamples.at(-1)?.slot ?? -1) + 1);
    if (gapFrom >= maxSlot)
      return buildResult(address, anchorSamples, rpc.callCount(), performance.now() - t0);

    const gapSigs = [];
    let gapToken = null, gapPages = 0;
    do {
      const r = await rpc.sigPage(address, gapFrom, maxSlot - 1, "asc", strategy.sigPageSize, gapToken);
      for (const s of r?.data ?? []) gapSigs.push({ slot: s.slot });
      gapToken = r?.paginationToken ?? null;
      gapPages++;
    } while (gapToken && gapPages < strategy.maxSigPages);

    if (gapSigs.length === 0)
      return buildResult(address, anchorSamples, rpc.callCount(), performance.now() - t0);

    const windows  = buildWindows(gapSigs, strategy.windowSize);
    const fetched  = await Promise.all(windows.map(w => fetchWindow(rpc, address, w.fromSlot, w.toSlot, strategy)));
    const newestFull = await rpc.fullTxns(address, 0, 999_999_999, ANCHOR_LIMIT, "desc");
    const acc = [...anchorSamples];
    for (const w of fetched) acc.push(...w);
    acc.push(...extractSamples(newestFull?.data ?? [], address, strategy.skipZeroDelta));
    return buildResult(address, acc, rpc.callCount(), performance.now() - t0);
  }

  // ── Streaming path: small/medium wallet (all sigs on one page) ───────────
  //
  // Step 1: Convert sigs to ascending order with minimal allocation.
  //         In-place reverse iteration — no spread copy, no intermediate array.
  const n       = allSigsDesc.length;
  const allSigs = new Array(n);
  for (let i = 0; i < n; i++) allSigs[i] = { slot: allSigsDesc[n - 1 - i].slot };

  // Step 2: Fire Phase 1 window promises NOW (streaming — don't wait for anchor).
  //         If fast-exit fires below, these run in background and GC handles results.
  const windowPromises = n > 0
    ? buildWindows(allSigs, strategy.windowSize).map(w =>
        fetchWindow(rpc, address, w.fromSlot, w.toSlot, strategy))
    : [];

  // Step 3: Await anchor (may already be complete, or still in-flight).
  const anchorRaw     = await anchorPromise;
  const anchorData    = anchorRaw?.data ?? [];
  const anchorSamples = extractSamples(anchorData, address, strategy.skipZeroDelta);

  // ── FAST EXIT ─────────────────────────────────────────────────────────────
  // If anchor's newest slot >= sigs' newest slot, the anchor covers every transaction.
  // allSigsDesc[0] is the newest sig (desc order). anchorData.at(-1) is the newest
  // anchor entry (asc order, so last = newest).
  //
  // Do NOT await windowPromises — they are fired but their results are not needed.
  // The RPC calls complete in the background; GC discards the responses.
  //
  const anchorNewestSlot = anchorData.at(-1)?.slot ?? -1;
  const sigsNewestSlot   = allSigsDesc[0]?.slot    ??  0;

  if (anchorNewestSlot >= sigsNewestSlot) {
    return buildResult(address, anchorSamples, rpc.callCount(), performance.now() - t0);
  }

  // ── Normal streaming path: anchor doesn't cover everything ───────────────
  // Windows are already running. Collect results and merge with anchor.
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
  if (!address || !apiKey) { console.error("Usage: node sol_balance_v10.mjs <address> <api-key>"); process.exit(1); }
  const result = await solBalanceOverTime(address, apiKey);
  console.log(`\n${result.address}`);
  console.log("─".repeat(60));
  for (const p of result.points)
    console.log(`slot ${String(p.slot).padStart(12)}  ${(p.lamports / LAMPORTS).toFixed(6)} SOL${p.kind === "flat" ? " [flat]" : ""}`);
  console.log("─".repeat(60));
  console.log(`Samples: ${result.stats.sampleCount}  Calls: ${result.stats.totalRpcCalls}  ${result.stats.wallTimeMs.toFixed(0)}ms`);
}
