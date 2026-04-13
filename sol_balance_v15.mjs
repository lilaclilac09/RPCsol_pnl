/**
 * SOL Balance V15 — Free-tier compatible path.
 * Uses getSignaturesForAddress + single getTransaction calls only.
 */

export const DEFAULT_STRATEGY = {
  sigPageSize: 1000,
  maxSigPages: 6,
  txTarget: 20,
  maxConcurrency: 12,
  skipZeroDelta: false,
};

const RETRY_BASE_MS = 180;
const MAX_RETRIES = 4;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return () => new Promise(resolve => {
    const go = () => {
      active++;
      resolve(() => {
        active--;
        queue.shift()?.();
      });
    };
    active < limit ? go() : queue.push(go);
  });
}

async function withRetry(fn) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message || "");
      const transient = /429|503|timed out|ECONNRESET|fetch failed|terminated/i.test(msg);
      if (!transient || attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_MS * (2 ** attempt) + Math.floor(Math.random() * 90));
    }
  }
}

function makeRpc(apiKey, maxConcurrency) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const acquire = makeSemaphore(maxConcurrency);
  let calls = 0;

  const postRaw = body => withRetry(async () => {
    const release = await acquire();
    calls++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`);
      return JSON.parse(txt);
    } finally {
      release();
    }
  });

  const post = async body => {
    const json = await postRaw(body);
    if (json?.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  };

  const signatures = (address, limit, before = undefined) => post({
    jsonrpc: "2.0", id: calls + 1,
    method: "getSignaturesForAddress",
    params: [address, { limit, ...(before ? { before } : {}) }],
  });

  const transaction = signature => post({
    jsonrpc: "2.0", id: calls + 1,
    method: "getTransaction",
    params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
  });

  return { signatures, transaction, callCount: () => calls };
}

function extractSample(tx, address) {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const idx = keys.findIndex(k => (typeof k === "string" ? k : k?.pubkey) === address);
  if (idx < 0) return null;
  const pre = tx?.meta?.preBalances?.[idx] ?? 0;
  const post = tx?.meta?.postBalances?.[idx] ?? 0;
  return {
    slot: tx?.slot ?? 0,
    blockTime: tx?.blockTime ?? 0,
    signature: tx?.transaction?.signatures?.[0] ?? "",
    preLamports: pre,
    postLamports: post,
  };
}

function dedup(samples) {
  const map = new Map();
  for (const s of samples) {
    const k = s.signature || `${s.slot}:${s.preLamports}:${s.postLamports}`;
    if (!map.has(k)) map.set(k, s);
  }
  return [...map.values()].sort((a, b) => a.slot - b.slot);
}

function buildResult(address, rawSamples, rpcCalls, wallMs) {
  const samples = dedup(rawSamples);
  const points = [];
  let lastLamports = null;
  let lastSlot = null;
  for (const s of samples) {
    if (lastLamports !== null && lastSlot !== null && lastLamports !== s.preLamports && s.slot > lastSlot + 1) {
      points.push({ slot: s.slot - 1, lamports: lastLamports, kind: "flat" });
    }
    points.push({ slot: s.slot, lamports: s.postLamports, kind: "sample" });
    lastLamports = s.postLamports;
    lastSlot = s.slot;
  }

  return {
    address,
    points,
    openingLamports: samples[0]?.preLamports ?? 0,
    closingLamports: samples.at(-1)?.postLamports ?? 0,
    stats: {
      totalRpcCalls: rpcCalls,
      wallTimeMs: wallMs,
      sampleCount: samples.length,
      openGapsRemaining: 0,
      resolvedByContinuity: 0,
    },
  };
}

export async function solBalanceOverTime(address, apiKey, strategy = DEFAULT_STRATEGY) {
  const t0 = performance.now();
  const rpc = makeRpc(apiKey, strategy.maxConcurrency);

  // Fetch signature pages, filtering to succeeded (err===null) as we go.
  // Break once we have enough succeeded sigs to cover txTarget.
  const succeededSigs = [];
  let before = undefined;
  let rawSeen = 0;
  for (let page = 0; page < strategy.maxSigPages; page++) {
    const pageData = await rpc.signatures(address, strategy.sigPageSize, before);
    const arr = pageData ?? [];
    if (!arr.length) break;
    rawSeen += arr.length;
    for (const s of arr) { if (s.err === null) succeededSigs.push(s); }
    if (succeededSigs.length >= strategy.txTarget) break;
    before = arr[arr.length - 1]?.signature;
    if (!before || arr.length < strategy.sigPageSize) break; // no more pages
  }
  const selected = succeededSigs.slice(0, strategy.txTarget);
  const samples = [];

  await Promise.all(selected.map(async s => {
    try {
      const tx = await rpc.transaction(s.signature);
      if (!tx) return;
      const sample = extractSample(tx, address);
      if (!sample) return;
      if (strategy.skipZeroDelta && sample.preLamports === sample.postLamports) return;
      samples.push(sample);
    } catch {
      // Ignore individual transaction fetch failures.
    }
  }));

  return buildResult(address, samples, rpc.callCount(), performance.now() - t0);
}

const _isCLI = process.argv[1] && new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;
if (_isCLI) {
  const address = process.argv[2];
  const apiKey = process.argv[3] ?? process.env.HELIUS_API_KEY;
  if (!address || !apiKey) {
    console.error("Usage: node sol_balance_v15.mjs <address> <api-key>");
    process.exit(1);
  }
  const result = await solBalanceOverTime(address, apiKey);
  console.log(JSON.stringify(result.stats, null, 2));
}
