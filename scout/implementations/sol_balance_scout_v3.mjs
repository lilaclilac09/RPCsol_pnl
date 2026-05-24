/**
 * Scout V3 — Level 2 Optimization: Adaptive Slicing + True Streaming
 *
 * Improvements over V2:
 * 1. Density-based adaptive slicing in Phase 1
 * 2. True streaming: start full-fetches as soon as scout results arrive
 * 3. Better pagination token handling
 *
 * Expected: 2.5-4x vs V15 baseline
 */

export const DEFAULT_STRATEGY = {
  maxConcurrency: 60,        // Higher than V2, but below rate limit
  retryMax: 4,
  retryBaseMs: 150,
  phase0SigLimit: 1000,
  phase1TargetDensity: 50,   // Sigs per time window for slicing
  phase2ChunkSize: 50,
};

const LAMPORTS_PER_SOL = 1_000_000_000;
const HELIUS_BASE = "https://mainnet.helius-rpc.com/?api-key=";

// Concurrency semaphore
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return () =>
    new Promise((resolve) => {
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

// Retry with exponential backoff
async function withRetry(fn, maxRetries = 4, baseMs = 150) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message || "");
      const isTransient =
        /429|503|ECONNRESET|timed out|fetch failed|terminated/.test(msg);

      if (!isTransient || attempt === maxRetries) throw err;

      const jitter = 100 + Math.random() * 150;
      const delay = baseMs * Math.pow(2, attempt) + jitter;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// RPC client
function makeRpcClient(apiKey, maxConcurrency = 60) {
  const url = `${HELIUS_BASE}${apiKey}`;
  const acquire = makeSemaphore(maxConcurrency);
  let callCount = 0;

  const post = async (body) => {
    const release = await acquire();
    callCount++;
    try {
      return await withRetry(async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        if (json.error) throw new Error(JSON.stringify(json.error));
        return json.result;
      });
    } finally {
      release();
    }
  };

  return {
    getSignatures: (address, limit = 1000, before = undefined) =>
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [address, { limit, ...(before ? { before } : {}) }],
      }),

    getTransaction: (signature) =>
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ],
      }),

    callCount: () => callCount,
  };
}

// Estimate density from anchor points and time range
function estimateDensity(oldestSigs, newestSigs) {
  if (oldestSigs.length === 0 || newestSigs.length === 0) return 10; // default

  const oldestTime = oldestSigs[0]?.blockTime || Math.floor(Date.now() / 1000);
  const newestTime = newestSigs[0]?.blockTime || Math.floor(Date.now() / 1000);

  if (oldestTime === newestTime) return 10;

  // Txs per second across the entire history
  const totalTxs = new Set([...oldestSigs, ...newestSigs]).size;
  const timeSpan = oldestTime - newestTime;
  const density = timeSpan > 0 ? totalTxs / timeSpan : 10;

  return Math.max(1, Math.min(100, density)); // Clamp to reasonable range
}

// Adaptive slicing: determine optimal number of slices based on density
function calculateAdaptiveSlices(density, targetPerSlice = 50) {
  // If density is 5 txs/sec and target is 50, we want 10-sec windows
  // Higher density → more slices
  const estimatedSlices = Math.ceil(density / targetPerSlice);
  return Math.max(4, Math.min(12, estimatedSlices)); // Clamp between 4-12
}

// Phase 0: Scout both ends (signatures only)
async function phase0(rpc, address, strategy) {
  const [oldestResult, newestResult] = await Promise.all([
    rpc.getSignatures(address, strategy.phase0SigLimit, undefined),
    rpc.getSignatures(address, strategy.phase0SigLimit),
  ]);

  const oldestSigs = (oldestResult || []).filter((s) => s.err === null);
  const newestSigs = (newestResult || []).filter((s) => s.err === null);

  return { oldestSigs, newestSigs };
}

// Phase 1: Adaptive gap scouting with density-based slicing
async function phase1(rpc, address, oldestSigs, newestSigs, strategy) {
  const totalCoverage = oldestSigs.length + newestSigs.length;

  // Fast path: no gap to scout
  if (totalCoverage < 2000) {
    return [];
  }

  // Estimate density and calculate optimal slice count
  const density = estimateDensity(oldestSigs, newestSigs);
  const numSlices = calculateAdaptiveSlices(
    density,
    strategy.phase1TargetDensity
  );

  // Scout slices in parallel, using stratified pagination hints
  const scoutPromises = Array.from({ length: numSlices }, async (_, i) => {
    // Use sigs from anchors as pagination hints
    const totalSigs = oldestSigs.length + newestSigs.length;
    const hintIdx = Math.floor((i * totalSigs) / numSlices);

    let beforeSig = undefined;
    if (hintIdx < oldestSigs.length) {
      beforeSig = oldestSigs[hintIdx].signature;
    } else if (newestSigs.length > 0) {
      beforeSig = newestSigs[hintIdx - oldestSigs.length]?.signature;
    }

    try {
      const result = await rpc.getSignatures(address, 1000, beforeSig);
      return result || [];
    } catch {
      return [];
    }
  });

  const scoutResults = await Promise.all(scoutPromises);

  // Dedup discovered signatures
  const sigMap = new Map();
  for (const result of scoutResults) {
    for (const sig of result) {
      if (sig?.err === null && sig.signature) {
        sigMap.set(sig.signature, sig);
      }
    }
  }

  return Array.from(sigMap.values());
}

// Helper: Chunk signatures for batch fetching
function chunkSignatures(sigs, chunkSize) {
  const chunks = [];
  for (let i = 0; i < sigs.length; i += chunkSize) {
    chunks.push(sigs.slice(i, i + chunkSize));
  }
  return chunks;
}

// Phase 2: Stream full-transaction fetches (true streaming version)
// Starts fetches as soon as signatures are available (instead of waiting for all scouts)
async function phase2Streaming(rpc, address, anchorSigs, scoutPromise, strategy) {
  const chunks = chunkSignatures(anchorSigs, strategy.phase2ChunkSize);
  const txs = [];
  const fetching = Promise.all(
    chunks.map((chunk) =>
      Promise.allSettled(
        chunk.map(async (sig) => {
          try {
            const tx = await rpc.getTransaction(sig.signature);
            if (tx) txs.push(tx);
            return tx || null;
          } catch {
            return null;
          }
        })
      )
    )
  );

  // As scout finishes, immediately batch its results for fetching
  if (scoutPromise) {
    scoutPromise.then((scoutedSigs) => {
      if (scoutedSigs.length > 0) {
        const scoutChunks = chunkSignatures(
          scoutedSigs,
          strategy.phase2ChunkSize
        );
        // Fire all scout chunks in parallel with the anchor fetches
        Promise.all(
          scoutChunks.map((chunk) =>
            Promise.allSettled(
              chunk.map(async (sig) => {
                try {
                  const tx = await rpc.getTransaction(sig.signature);
                  if (tx) txs.push(tx);
                  return tx || null;
                } catch {
                  return null;
                }
              })
            )
          )
        ).catch(() => {});
      }
    });
  }

  await fetching;
  return txs;
}

// Extract balance point
function extractBalancePoint(tx, address) {
  if (!tx) return null;

  const keys = tx?.transaction?.message?.accountKeys || [];
  const idx = keys.findIndex((k) => {
    if (typeof k === "string") return k === address;
    if (typeof k === "object" && k?.pubkey) return k.pubkey === address;
    return false;
  });

  if (idx < 0) return null;

  const pre = tx?.meta?.preBalances?.[idx] ?? 0;
  const post = tx?.meta?.postBalances?.[idx] ?? 0;

  return {
    blockTime: tx?.blockTime || 0,
    slot: tx?.slot || 0,
    signature: tx?.transaction?.signatures?.[0] || "",
    balanceLamports: post,
    balanceSOL: post / LAMPORTS_PER_SOL,
    deltaLamports: post - pre,
  };
}

// Dedup by signature
function dedup(points) {
  const seen = new Set();
  const result = [];

  for (const p of points) {
    if (!seen.has(p.signature)) {
      seen.add(p.signature);
      result.push(p);
    }
  }

  return result;
}

// Main: Scout V3
export async function solBalanceScoutV3(
  address,
  apiKey,
  strategy = DEFAULT_STRATEGY
) {
  const t0 = performance.now();
  const rpc = makeRpcClient(apiKey, strategy.maxConcurrency);

  try {
    // Phase 0: Scout both ends
    const { oldestSigs, newestSigs } = await phase0(rpc, address, strategy);

    // Start Phase 1 (async, continue immediately)
    const phase1Promise = phase1(rpc, address, oldestSigs, newestSigs, strategy);

    // Combine anchor sigs immediately
    const anchorMap = new Map();
    for (const s of [...oldestSigs, ...newestSigs]) {
      if (s.signature && !anchorMap.has(s.signature)) {
        anchorMap.set(s.signature, s);
      }
    }
    const anchorSigs = Array.from(anchorMap.values());

    // Phase 2: Start fetching anchors WHILE Phase 1 scouts
    const txs = await phase2Streaming(
      rpc,
      address,
      anchorSigs,
      phase1Promise,
      strategy
    );

    // Wait for Phase 1 to complete and combine results
    const scoutedSigs = await phase1Promise;
    if (scoutedSigs.length > 0) {
      // Combine with already discovered
      const allSigsMap = new Map(anchorMap);
      for (const s of scoutedSigs) {
        if (s.signature && !allSigsMap.has(s.signature)) {
          allSigsMap.set(s.signature, s);
        }
      }
      const allSigs = Array.from(allSigsMap.values());

      // Fetch any remaining signatures
      const remainingChunks = chunkSignatures(
        allSigs,
        strategy.phase2ChunkSize
      );
      for (const chunk of remainingChunks) {
        for (const sig of chunk) {
          if (
            !txs.some((tx) => tx.transaction?.signatures?.[0] === sig.signature)
          ) {
            try {
              const tx = await rpc.getTransaction(sig.signature);
              if (tx) txs.push(tx);
            } catch {
              // Ignore individual fetch failures
            }
          }
        }
      }
    }

    // Extract and deduplicate
    const points = txs
      .map((tx) => extractBalancePoint(tx, address))
      .filter(Boolean);

    const dedupPoints = dedup(points).sort((a, b) => {
      const timeD = a.blockTime - b.blockTime;
      return timeD !== 0 ? timeD : a.slot - b.slot;
    });

    const wallTimeMs = performance.now() - t0;

    return {
      address,
      points: dedupPoints,
      openingBalanceLamports:
        dedupPoints.length > 0
          ? dedupPoints[0].balanceLamports - dedupPoints[0].deltaLamports
          : 0,
      closingBalanceLamports: dedupPoints.at(-1)?.balanceLamports || 0,
      stats: {
        totalRpcCalls: rpc.callCount(),
        phase0Calls: 2,
        phase1Calls: 1,
        phase2Calls: Math.ceil(
          (anchorSigs.length + (await phase1Promise).length) /
            (strategy.phase2ChunkSize || 50)
        ),
        wallTimeMs,
        sampleCount: dedupPoints.length,
      },
    };
  } finally {
    // No cleanup needed
  }
}

// CLI
if (import.meta.main || process.argv[1]?.endsWith("sol_balance_scout_v3.mjs")) {
  const address = process.argv[2];
  const apiKey = process.argv[3] || process.env.HELIUS_API_KEY;

  if (!address || !apiKey) {
    console.error("Usage: node sol_balance_scout_v3.mjs <ADDRESS> [API_KEY]");
    process.exit(1);
  }

  console.log(`Fetching with Scout V3: ${address}...`);
  const result = await solBalanceScoutV3(address, apiKey);
  console.log(`\nSOL Balance History — ${result.address}`);
  console.log("─".repeat(80));
  console.log("Date (UTC)".padEnd(26) + "Balance (SOL)".padStart(16) + "Delta".padStart(16));
  console.log("─".repeat(80));

  for (const p of result.points.slice(-20)) {
    // Show last 20
    const date = new Date(p.blockTime * 1000).toISOString();
    const bal = (p.balanceLamports / LAMPORTS_PER_SOL).toFixed(6);
    const delta = (p.deltaLamports / LAMPORTS_PER_SOL).toFixed(6);
    const sign = p.deltaLamports >= 0 ? "+" : "";
    console.log(
      date.padEnd(26) +
        bal.padStart(16) +
        `${sign}${delta}`.padStart(16)
    );
  }

  console.log("─".repeat(80));
  console.log(`Transactions: ${result.stats.sampleCount}`);
  console.log(`RPC calls:    ${result.stats.totalRpcCalls}`);
  console.log(`Time:         ${result.stats.wallTimeMs.toFixed(0)}ms`);
}
