/**
 * eval_v15_stable — 3-run median evaluation for V15 (free-tier solver)
 *
 * V15 uses getSignaturesForAddress + getTransaction (standard RPC, free tier).
 * Runs each wallet RUNS times; median wall time is used to reduce RTT jitter.
 *
 * Score formula:
 *   base  = (completeness × 1000 / avgLatencyMs) × max(0.1, 1 − 0.05 × openGapPenalty)
 *   gate  = if ANY wallet ≥ 3000ms → ×0.05  |  ≥ 2000ms → ×0.60  |  else 1.0
 *   score = base × gate
 *
 * Completeness: each wallet needs sampleCount ≥ expectedMinSamples.
 *   sparse:  4   (4-txn wallet, all covered)
 *   medium: 30   (60-txn wallet, covered by txTarget)
 *   dense: 100   (451-txn wallet, txTarget must be ≥ 100)
 */
import { solBalanceOverTime } from "./sol_balance_v15.mjs";

export const RUNS = 3;

export const TEST_WALLETS = [
  { address: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs", type: "sparse",   expectedMinSamples: 4   },
  { address: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs", type: "medium",   expectedMinSamples: 30  },
  { address: "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n", type: "dense",    expectedMinSamples: 100 },
];

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function evaluate(strategy, apiKey, runs = RUNS) {
  const results = [];
  for (const wallet of TEST_WALLETS) {
    const wallMsArr = [], rpcArr = [], sampleArr = [], gapArr = [];
    let anyComplete = false;
    for (let r = 0; r < runs; r++) {
      try {
        const t0     = performance.now();
        const result = await solBalanceOverTime(wallet.address, apiKey, strategy);
        const wallMs = performance.now() - t0;
        wallMsArr.push(wallMs);
        rpcArr.push(result.stats.totalRpcCalls);
        sampleArr.push(result.stats.sampleCount);
        gapArr.push(result.stats.openGapsRemaining);
        if (result.stats.sampleCount >= wallet.expectedMinSamples) anyComplete = true;
      } catch (err) {
        wallMsArr.push(120000);
        rpcArr.push(999);
        sampleArr.push(0);
        gapArr.push(99);
      }
    }
    results.push({
      wallet: wallet.address, type: wallet.type,
      wallMs:     median(wallMsArr),
      wallMsMin:  Math.min(...wallMsArr),
      wallMsMax:  Math.max(...wallMsArr),
      wallMsAll:  wallMsArr,
      rpcCalls:   Math.round(median(rpcArr)),
      sampleCount: Math.round(median(sampleArr)),
      openGaps:   Math.round(median(gapArr)),
      complete:   anyComplete,
    });
  }

  const avgLatencyMs   = results.reduce((s, r) => s + r.wallMs,   0) / results.length;
  const maxWalletMs    = Math.max(...results.map(r => r.wallMs));
  const totalRpc       = results.reduce((s, r) => s + r.rpcCalls, 0);
  const openGapPenalty = results.reduce((s, r) => s + r.openGaps, 0);
  const completeness   = results.filter(r => r.complete).length / results.length;

  const gate = maxWalletMs >= 3000 ? 0.05
             : maxWalletMs >= 2000 ? 0.60
             : 1.0;

  const score = completeness > 0
    ? (completeness * 1000 / avgLatencyMs) * Math.max(0.1, 1 - 0.05 * openGapPenalty) * gate
    : 0;

  return { strategy, results, runs,
           aggregate: { avgLatencyMs, maxWalletMs, totalRpc, openGapPenalty, completeness, score, gate } };
}
