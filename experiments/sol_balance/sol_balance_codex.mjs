/**
 * SOL Balance History — Codex Variant (from sol_pnl.ts)
 *
 * Ported to Node.js ESM from the Codex-generated TypeScript version.
 *
 * Key differences from V2/V3:
 *   - Uses blockTime filters (not slot filters) — avoids Helius slot-range quirks
 *   - Phase 1: newest-100 + oldest-100 in PARALLEL (same as V3)
 *   - Phase 2: EXACTLY ONE sig call for the gap (not paginated)
 *     SPARSE (<1000 sigs): exact positions → zero-overflow windows
 *     DENSE  (≥1000 sigs): density estimate from 3 measurements → time-based windows
 *   - No oracle, no sig pagination — always 2 serial round-trips minimum
 *
 * This caps Phase 2 at 1 call regardless of wallet size, trading
 * accuracy for speed on dense wallets (windows may need overflow pagination).
 */

const LAMPORTS = 1_000_000_000;
const MAX_CONCURRENCY = 12;
const MAX_RETRIES     = 4;
const RETRY_BASE_MS   = 250;

export const DEFAULT_STRATEGY = {
  windowTarget:   80,  // target txns per Phase 3 window
  maxConcurrency: 12,
};

function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return () => new Promise(resolve => {
    const go = () => { active++; resolve(() => { active--; queue.shift()?.(); }); };
    active < limit ? go() : queue.push(go);
  });
}

async function withRetry(fn) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try { return await fn(); }
    catch (err) {
      const transient = err.code === "ECONNRESET" ||
        /429|503|terminated|fetch failed/i.test(err.message ?? "");
      if (!transient || i === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * 2 ** i + Math.random() * 100));
    }
  }
}

function makeRpc(apiKey, maxConcurrency) {
  const url     = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const acquire = makeSemaphore(maxConcurrency);
  let n = 0;

  const post = body => withRetry(async () => {
    const release = await acquire();
    n++;
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => String(r.status));
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 80)}`);
      }
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } finally { release(); }
  });

  const full = (address, opts) => post({
    jsonrpc: "2.0", id: n + 1,
    method: "getTransactionsForAddress",
    params: [address, { transactionDetails: "full", encoding: "jsonParsed",
                        maxSupportedTransactionVersion: 0, ...opts }],
  });

  const sigs = (address, opts) => post({
    jsonrpc: "2.0", id: n + 1,
    method: "getTransactionsForAddress",
    params: [address, { transactionDetails: "signatures", ...opts }],
  });

  return { full, sigs, callCount: () => n };
}

// ── Window construction ────────────────────────────────────────────────────────

function windowsFromSigs(sigList, size = 90) {
  const out = [];
  for (let i = 0; i < sigList.length; i += size) {
    const chunk  = sigList.slice(i, i + size);
    const tStart = chunk[0].blockTime;
    const next   = sigList[i + size];
    const tEnd   = next ? next.blockTime : chunk.at(-1).blockTime + 1;
    out.push({ tStart, tEnd });
  }
  return out;
}

function windowsFromDensity(tStart, tEnd, density, target = 80) {
  const windowSecs = Math.max(1, Math.floor(target / density));
  const out = [];
  for (let t = tStart; t < tEnd; t += windowSecs)
    out.push({ tStart: t, tEnd: Math.min(t + windowSecs, tEnd) });
  return out;
}

// ── Fetch one time window ──────────────────────────────────────────────────────

async function fetchWindow(address, rpcFull, tStart, tEnd) {
  const all = [];
  let token = null;
  do {
    const r = await rpcFull(address, {
      sortOrder: "asc", limit: 100,
      filters: { status: "succeeded", blockTime: { gte: tStart, lt: tEnd } },
      ...(token ? { paginationToken: token } : {}),
    });
    all.push(...(r?.data ?? []));
    token = r?.paginationToken ?? null;
  } while (token);
  return all;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function dedup(txns) {
  const seen = new Set();
  return txns.filter(tx => {
    const s = tx.transaction?.signatures?.[0];
    if (!s || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

function toPoints(txns, address) {
  const out = [];
  for (const tx of txns) {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const idx  = keys.findIndex(k => (typeof k === "string" ? k : k?.pubkey) === address);
    if (idx < 0) continue;
    const pre  = tx.meta?.preBalances?.[idx]  ?? 0;
    const post = tx.meta?.postBalances?.[idx] ?? 0;
    out.push({ slot: tx.slot, signature: tx.transaction?.signatures?.[0] ?? "",
               preLamports: pre, postLamports: post });
  }
  return out;
}

function buildResult(address, samples, rpcCalls, wallMs) {
  const deduped = samples
    .filter((s, i, a) => a.findIndex(x => x.signature === s.signature) === i)
    .sort((a, b) => a.slot - b.slot);
  const points = [];
  let lastLamports = null, lastSlot = null;
  for (const s of deduped) {
    if (lastLamports !== null && lastSlot !== null && lastLamports !== s.preLamports && s.slot > lastSlot + 1)
      points.push({ slot: s.slot - 1, lamports: lastLamports, kind: "flat" });
    points.push({ slot: s.slot, lamports: s.postLamports, kind: "sample" });
    lastLamports = s.postLamports; lastSlot = s.slot;
  }
  return {
    address, points,
    openingLamports: deduped[0]?.preLamports    ?? 0,
    closingLamports: deduped.at(-1)?.postLamports ?? 0,
    stats: { totalRpcCalls: rpcCalls, wallTimeMs: wallMs,
             sampleCount: deduped.length, openGapsRemaining: 0, resolvedByContinuity: 0 },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function solBalanceOverTime(address, apiKey, strategy = DEFAULT_STRATEGY) {
  const t0       = performance.now();
  const conc     = strategy.maxConcurrency ?? MAX_CONCURRENCY;
  const target   = strategy.windowTarget   ?? 80;
  const rpc      = makeRpc(apiKey, conc);

  // Phase 1: newest + oldest in parallel
  const baseFilter = { status: "succeeded" };
  const [newest, oldest] = await Promise.all([
    rpc.full(address, { sortOrder: "desc", limit: 100, filters: baseFilter }),
    rpc.full(address, { sortOrder: "asc",  limit: 100, filters: baseFilter }),
  ]);

  let allTxns;

  if (!newest?.paginationToken) {
    // ≤ 100 transactions — fast path
    allTxns = newest?.data ?? [];
  } else {
    const tMin         = oldest?.data?.[0]?.blockTime  ?? 0;
    const tMax         = newest?.data?.[0]?.blockTime  ?? Math.floor(Date.now() / 1000);
    const tAfterOldest = (oldest?.data?.at(-1)?.blockTime ?? tMin) + 1;
    const tBeforeNewest = newest?.data?.at(-1)?.blockTime ?? tMax;

    if (tAfterOldest >= tBeforeNewest) {
      allTxns = dedup([...(oldest?.data ?? []), ...(newest?.data ?? [])]);
    } else {
      // Phase 2: single gap probe
      const probe = await rpc.sigs(address, {
        sortOrder: "asc", limit: 1000,
        filters: { status: "succeeded", blockTime: { gte: tAfterOldest, lt: tBeforeNewest } },
      });

      let windows;
      if (!probe?.paginationToken) {
        // SPARSE: exact positions — zero-overflow windows
        windows = windowsFromSigs(probe?.data ?? [], target);
      } else {
        // DENSE: 3-point density estimate, take max for safety
        const tProbeEnd = probe?.data?.at(-1)?.blockTime ?? tBeforeNewest;
        const dOldest   = 100  / Math.max(1, tAfterOldest  - tMin);
        const dNewest   = 100  / Math.max(1, tMax - tBeforeNewest);
        const dProbe    = 1000 / Math.max(1, tProbeEnd - tAfterOldest);
        const density   = Math.max(dOldest, dNewest, dProbe);
        windows = windowsFromDensity(tAfterOldest, tBeforeNewest, density, target);
      }

      // Phase 3: parallel full fetch
      const gapTxns = (await Promise.all(
        windows.map(w => fetchWindow(address, rpc.full, w.tStart, w.tEnd))
      )).flat();

      allTxns = dedup([
        ...(oldest?.data ?? []),
        ...(newest?.data ?? []),
        ...gapTxns,
      ]);
    }
  }

  allTxns.sort((a, b) => {
    const d = (a.blockTime ?? 0) - (b.blockTime ?? 0);
    return d !== 0 ? d : a.slot - b.slot;
  });

  const samples = toPoints(allTxns, address);
  return buildResult(address, samples, rpc.callCount(), performance.now() - t0);
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;

if (_isCLI) {
  const address = process.argv[2];
  const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;
  if (!address || !apiKey) { console.error("Usage: node sol_balance_codex.mjs <address> <api-key>"); process.exit(1); }
  console.log(`[codex] Fetching SOL balance for ${address}...`);
  const result = await solBalanceOverTime(address, apiKey);
  console.log(`\n${result.address}`);
  console.log("─".repeat(60));
  for (const p of result.points)
    console.log(`slot ${String(p.slot).padStart(12)}  ${(p.lamports / LAMPORTS).toFixed(6)} SOL${p.kind === "flat" ? " [flat]" : ""}`);
  console.log("─".repeat(60));
  console.log(`Samples: ${result.stats.sampleCount}  Calls: ${result.stats.totalRpcCalls}  ${result.stats.wallTimeMs.toFixed(0)}ms`);
}
