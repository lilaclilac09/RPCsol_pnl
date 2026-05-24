/**
 * SOL Balance V3 — Merged Anchor-Sig
 *
 * Key innovation over V2: eliminates one full serial round-trip by running
 * the signature discovery call IN PARALLEL with the oldest-anchor full fetch.
 *
 * V2 had 3 serial phases:
 *   Phase 0: newest anchor + oldest anchor  (1 round-trip)
 *   Phase 1: sig scan of gap               (1 round-trip)
 *   Phase 2: parallel full fetches         (1 round-trip)
 *   ─────────────────────────────────────
 *   Total: 3 serial round-trips minimum
 *
 * V3 has 2 serial phases:
 *   Phase 0: [oldest full + newest SIGNATURES] in parallel (1 round-trip)
 *            → oldest full gives us minSlot + old samples
 *            → newest sigs give us ALL sig positions if ≤ sigPageSize total
 *   Phase 1: parallel full fetches for gap windows         (1 round-trip)
 *   ─────────────────────────────────────
 *   Total: 2 serial round-trips minimum
 *
 * For wallets with ≤ sigPageSize (1000) total transactions:
 *   Phase 0 delivers: old samples + all sig positions in one shot
 *   Phase 1: batch full-fetch windows  (1 parallel round-trip)
 *   Call count: 2 + ceil(N / windowSize) — same as V2 but 1 round-trip faster
 *
 * For tiny wallets (all fit in anchorSize):
 *   Phase 0 sig call returns all sigs. Phase 0 full call returns all samples.
 *   Fast-exit in 2 calls, no Phase 1 needed.
 *
 * For large wallets (> 1000 txns):
 *   Phase 0 sig call returns 1000 sigs with paginationToken.
 *   Paginate sigs sequentially (same as V2), then Phase 1.
 */

export const DEFAULT_STRATEGY = {
  anchorSize:          100,   // full txns in oldest anchor
  sigPageSize:         1000,  // sigs per discovery call
  windowSize:           80,   // target txns per full-fetch window
  maxSigPages:          20,   // safety cap on sig pagination
  maxConcurrency:        8,
  skipZeroDelta:       true,
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

  // Build a slot sub-filter only for the bounds that are actually constrained.
  // Helius rejects { gte: 0 } and requires gte >= 1 when a lower-bound is present.
  const slotFilter = (from, to) => {
    const f = {};
    if (from > 0)           f.gte = from;
    if (to < 999_999_999)   f.lte = to;
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
    const keys = tx?.transaction?.message?.accountKeys ?? [];
    const idx  = keys.findIndex(k => (typeof k === "string" ? k : k?.pubkey) === address);
    if (idx < 0) continue;
    const pre  = tx.meta?.preBalances?.[idx]  ?? 0;
    const post = tx.meta?.postBalances?.[idx] ?? 0;
    if (skipZeroDelta && pre === post) continue;
    out.push({ slot: tx.slot, signature: tx.transaction?.signatures?.[0] ?? "", preLamports: pre, postLamports: post });
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

function buildWindows(sigs, windowSize) {
  const windows = [];
  for (let i = 0; i < sigs.length; i += windowSize)
    windows.push({ fromSlot: sigs[i].slot, toSlot: sigs[Math.min(i + windowSize - 1, sigs.length - 1)].slot });
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
// Main algorithm
// ─────────────────────────────────────────────────────────────────────────────

export async function solBalanceOverTime(address, apiKey, strategy = DEFAULT_STRATEGY) {
  const t0  = performance.now();
  const rpc = makeRpc(apiKey, strategy.maxConcurrency);

  // ── Phase 0: One parallel round-trip — oldest full + newest signatures ─────
  //
  // Oldest full:  gives us the first anchorSize samples + minSlot
  // Newest sigs:  if ≤ sigPageSize total, we get ALL sig positions here —
  //               no separate Phase 1 needed for most wallets
  //
  const anchorLimit = Math.min(strategy.anchorSize, 100);

  const [oldestRaw, newestSigs] = await Promise.all([
    rpc.fullTxns(address, 0, 999_999_999, anchorLimit, "asc"),
    rpc.sigPage(address, 0, 999_999_999, "desc", strategy.sigPageSize),
  ]);

  const oldestSamples = extractSamples(oldestRaw?.data ?? [], address, strategy.skipZeroDelta);
  const allSigsDesc   = newestSigs?.data ?? [];
  // Helius sometimes returns a paginationToken even when results < limit (API quirk).
  // Treat as truncated only when we actually hit the page limit.
  const sigsTruncated = !!newestSigs?.paginationToken && allSigsDesc.length >= strategy.sigPageSize;

  // All sigs sorted ascending (flip from desc)
  let allSigs = [...allSigsDesc].reverse().map(s => ({ slot: s.slot, sig: s.signature ?? "" }));

  // Fast-exit: if sig call got everything (no truncation) and oldest anchor
  // covers the same txns we have in sigs, we can fetch full txns for the rest
  // directly. But first check if oldest full anchor already overlaps with sigs.
  const oldestLastSlot  = oldestSamples.at(-1)?.slot ?? -1;
  const newestFirstSlot = allSigs[0]?.slot ?? Infinity;

  // Case 1: anchor full covers the entire wallet (all sigs fit in oldest anchor page)
  if (!oldestRaw?.paginationToken && allSigs.length <= oldestSamples.length) {
    // The oldest anchor got everything
    return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);
  }

  // Case 2: no more sigs beyond what we fetched AND oldest anchor overlaps
  if (!sigsTruncated && oldestLastSlot >= newestFirstSlot) {
    // Two anchor pages together cover everything; need full txns for all sigs
    const gapSigs = allSigs.filter(s => s.slot > oldestLastSlot);
    if (gapSigs.length === 0)
      return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);

    const windows = buildWindows(gapSigs, strategy.windowSize);
    const fetched = await Promise.all(windows.map(w => fetchWindow(rpc, address, w.fromSlot, w.toSlot, strategy)));
    return buildResult(address, [...oldestSamples, ...fetched.flat()], rpc.callCount(), performance.now() - t0);
  }

  // Case 3: sigs not truncated — we have ALL sig positions in one call
  if (!sigsTruncated) {
    // Filter sigs that are NOT already covered by oldest anchor
    const gapSigs = allSigs.filter(s => s.slot > oldestLastSlot);

    if (gapSigs.length === 0)
      return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);

    const windows = buildWindows(gapSigs, strategy.windowSize);
    const fetched = await Promise.all(windows.map(w => fetchWindow(rpc, address, w.fromSlot, w.toSlot, strategy)));
    return buildResult(address, [...oldestSamples, ...fetched.flat()], rpc.callCount(), performance.now() - t0);
  }

  // Case 4: wallet has > sigPageSize transactions — paginate sigs sequentially
  // Re-enumerate the gap ascending to get proper order for windowing.
  // maxSlot: newest sig slot from the desc page (allSigsDesc[0] is the newest).
  // gapFrom: one slot above the oldest anchor's last slot (or 1 if anchor was empty).
  const maxSlot = allSigsDesc[0]?.slot ?? 999_999_999;
  const gapFrom = Math.max(1, oldestLastSlot + 1);

  // If anchor already covers up to or past maxSlot, there's no gap to fetch.
  if (gapFrom >= maxSlot)
    return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);

  const gapSigs = [];
  let gapToken  = null;
  let gapPages  = 0;
  do {
    const r = await rpc.sigPage(address, gapFrom, maxSlot - 1, "asc", strategy.sigPageSize, gapToken);
    const page = r?.data ?? [];
    for (const s of page) gapSigs.push({ slot: s.slot, sig: s.signature ?? "" });
    gapToken = r?.paginationToken ?? null;
    gapPages++;
  } while (gapToken && gapPages < strategy.maxSigPages);

  if (gapSigs.length === 0)
    return buildResult(address, oldestSamples, rpc.callCount(), performance.now() - t0);

  const windows = buildWindows(gapSigs, strategy.windowSize);
  const fetched = await Promise.all(windows.map(w => fetchWindow(rpc, address, w.fromSlot, w.toSlot, strategy)));

  // Also need newest full txns (we only have sigs for them, not full data)
  const newestFull = await rpc.fullTxns(address, 0, 999_999_999, anchorLimit, "desc");
  const newestSamples = extractSamples(newestFull?.data ?? [], address, strategy.skipZeroDelta);

  return buildResult(address, [...oldestSamples, ...fetched.flat(), ...newestSamples],
    rpc.callCount(), performance.now() - t0);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const address = process.argv[2];
  const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;
  if (!address || !apiKey) { console.error("Usage: node sol_balance_v3.mjs <address> <api-key>"); process.exit(1); }
  console.log(`[v3] Fetching SOL balance for ${address}...`);
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
