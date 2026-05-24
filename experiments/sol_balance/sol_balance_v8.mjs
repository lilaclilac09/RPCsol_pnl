/**
 * SOL Balance V8 — Streaming Pipeline
 *
 * Key innovation over V3: starts Phase 1 window fetches as soon as the
 * signatures call completes, WITHOUT waiting for the oldest-anchor full-fetch.
 *
 * V3 (2 serial phases, sequential within Phase 0):
 *   t=0:    fire [oldestFull || newestSigs] in parallel
 *   t=~500: BOTH must complete → derive windows → start Phase 1
 *   t=~900: Phase 1 done
 *
 * V8 (streaming — Phase 1 starts before Phase 0 finishes):
 *   t=0:    fire oldestFull (large payload, slow)
 *   t=0:    fire newestSigs (small payload, fast)
 *   t=~300: newestSigs arrives → immediately derive ALL windows → start Phase 1
 *   t=~500: oldestFull arrives (Phase 1 already running 200ms)
 *   t=~750: Phase 1 done
 *   Savings: ~150–250ms per wallet
 *
 * Trade-off: 1–2 extra window calls overlap with anchor data.
 * dedup() handles the redundancy. Score metric does NOT penalise extra calls.
 *
 * Note: encoding: "json" (smaller payloads) was tested but requires a paid Helius
 * plan tier — kept as "jsonParsed" for free-tier compatibility.
 */

export const DEFAULT_STRATEGY = {
  anchorSize:      100,
  sigPageSize:     1000,
  windowSize:       80,
  maxSigPages:      20,
  maxConcurrency:    8,
  skipZeroDelta:  true,
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
        filters: {
          ...slotFilter(fromSlot, toSlot),
          status: "succeeded",
        },
        ...(token ? { paginationToken: token } : {}),
      }],
    });

  return { fullTxns, sigPage, callCount: () => calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractSamples(data, address, skipZeroDelta) {
  const out = [];
  for (const tx of data ?? []) {
    // Handle both "json" encoding (string keys) and "jsonParsed" ({pubkey} objects)
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
  const seen = new Set();
  return samples
    .filter(s => {
      const k = s.signature || `${s.slot}:${s.preLamports}:${s.postLamports}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    })
    .sort((a, b) => a.slot - b.slot);
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

function buildWindows(sigs, windowSize) {
  const windows = [];
  for (let i = 0; i < sigs.length; i += windowSize)
    windows.push({
      fromSlot: sigs[i].slot,
      toSlot:   sigs[Math.min(i + windowSize - 1, sigs.length - 1)].slot,
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
// Main algorithm — Streaming Pipeline
// ─────────────────────────────────────────────────────────────────────────────

export async function solBalanceOverTime(address, apiKey, strategy = DEFAULT_STRATEGY) {
  const t0  = performance.now();
  const rpc = makeRpc(apiKey, strategy.maxConcurrency);
  const anchorLimit = Math.min(strategy.anchorSize, 100);

  // ── Phase 0: Fire both calls simultaneously, but don't Promise.all ──────────
  //
  // V3 used Promise.all → waited for BOTH before continuing.
  // V8: fire both, then await newestSigs FIRST (smaller payload → arrives sooner).
  // The moment sigs arrive we know all transaction positions → start Phase 1 NOW.
  // oldestFull may still be in-flight; it completes in the background.
  //
  const oldestRawPromise  = rpc.fullTxns(address, 0, 999_999_999, anchorLimit, "asc");
  const newestSigsPromise = rpc.sigPage(address, 0, 999_999_999, "desc", strategy.sigPageSize);

  // Wait for sigs — typically faster (small JSON payload vs large full-tx payload)
  const newestSigs    = await newestSigsPromise;
  const allSigsDesc   = newestSigs?.data ?? [];
  const sigsTruncated = !!newestSigs?.paginationToken && allSigsDesc.length >= strategy.sigPageSize;
  const allSigs       = [...allSigsDesc].reverse().map(s => ({ slot: s.slot, sig: s.signature ?? "" }));

  // ── Case: large wallet (> sigPageSize txns) ──────────────────────────────
  // Sigs are truncated → must paginate. No streaming benefit here.
  // Fall through to V3-style anchor + sequential sig pagination.
  if (sigsTruncated) {
    const oldestRaw     = await oldestRawPromise;
    const oldestSamples = extractSamples(oldestRaw?.data ?? [], address, strategy.skipZeroDelta);

    const maxSlot = allSigsDesc[0]?.slot ?? 999_999_999;
    const gapFrom = Math.max(1, (oldestSamples.at(-1)?.slot ?? -1) + 1);

    if (gapFrom >= maxSlot)
      return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);

    const gapSigs = [];
    let gapToken  = null, gapPages = 0;
    do {
      const r = await rpc.sigPage(address, gapFrom, maxSlot - 1, "asc", strategy.sigPageSize, gapToken);
      for (const s of r?.data ?? []) gapSigs.push({ slot: s.slot, sig: s.signature ?? "" });
      gapToken = r?.paginationToken ?? null;
      gapPages++;
    } while (gapToken && gapPages < strategy.maxSigPages);

    if (gapSigs.length === 0)
      return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);

    const windows  = buildWindows(gapSigs, strategy.windowSize);
    const fetched  = await Promise.all(windows.map(w => fetchWindow(rpc, address, w.fromSlot, w.toSlot, strategy)));
    const newestFull = await rpc.fullTxns(address, 0, 999_999_999, anchorLimit, "desc");
    const newestSamples = extractSamples(newestFull?.data ?? [], address, strategy.skipZeroDelta);
    return buildResult(address, [...oldestSamples, ...fetched.flat(), ...newestSamples],
      rpc.callCount(), performance.now() - t0);
  }

  // ── Streaming path (small/medium wallet, all sigs fit on one page) ────────
  //
  // We have ALL sig positions. Start Phase 1 windows from ALL sigs immediately —
  // don't wait for oldestFull, don't filter by anchor overlap.
  // Trade: 1–2 redundant window calls. Gain: Phase 1 starts ~150–250ms earlier.
  // dedup() in buildResult() handles the overlap transparently.
  //
  let windowPromises = [];
  if (allSigs.length > 0) {
    const windows  = buildWindows(allSigs, strategy.windowSize);
    windowPromises = windows.map(w => fetchWindow(rpc, address, w.fromSlot, w.toSlot, strategy));
  }

  // Now await oldestFull — may already be done, may still be in-flight.
  // Either way, Phase 1 windows are already running in parallel.
  const oldestRaw     = await oldestRawPromise;
  const oldestSamples = extractSamples(oldestRaw?.data ?? [], address, strategy.skipZeroDelta);

  // Collect Phase 1 results
  const windowResults = await Promise.all(windowPromises);

  // Merge anchor + windows; dedup sorts and removes duplicates
  return buildResult(address, [...oldestSamples, ...windowResults.flat()],
    rpc.callCount(), performance.now() - t0);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const address = process.argv[2];
  const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;
  if (!address || !apiKey) { console.error("Usage: node sol_balance_v8.mjs <address> <api-key>"); process.exit(1); }
  console.log(`[v8] Fetching SOL balance for ${address}...`);
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
