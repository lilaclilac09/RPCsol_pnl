/**
 * Evaluation harness for V4 (hybrid merged-anchor + density probe).
 */

import { solBalanceOverTime } from "./sol_balance_v4.mjs";

export const TEST_WALLETS = [
  { address: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs", type: "sparse",   expectedMinSamples: 4   },
  { address: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs", type: "medium",   expectedMinSamples: 30  },
  { address: "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n", type: "dense",    expectedMinSamples: 100 },
];

export async function evaluate(strategy, apiKey, { timeout = 120_000 } = {}) {
  const results = [];

  for (const wallet of TEST_WALLETS) {
    const timer = setTimeout(() => {}, timeout);  // placeholder; actual timeout via strategy
    try {
      const t0     = performance.now();
      const result = await solBalanceOverTime(wallet.address, apiKey, strategy);
      const wallMs = performance.now() - t0;

      results.push({
        wallet:      wallet.address,
        type:        wallet.type,
        wallMs,
        rpcCalls:    result.stats.totalRpcCalls,
        sampleCount: result.stats.sampleCount,
        openGaps:    result.stats.openGapsRemaining,
        complete:    result.stats.sampleCount >= wallet.expectedMinSamples,
      });
    } catch (err) {
      results.push({
        wallet:      wallet.address,
        type:        wallet.type,
        wallMs:      timeout,
        rpcCalls:    60,
        sampleCount: 0,
        openGaps:    99,
        complete:    false,
        error:       err.message,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const avgLatencyMs   = results.reduce((s, r) => s + r.wallMs,   0) / results.length;
  const totalRpc       = results.reduce((s, r) => s + r.rpcCalls, 0);
  const openGapPenalty = results.reduce((s, r) => s + r.openGaps, 0);
  const completeness   = results.filter(r => r.complete).length / results.length;

  const score = completeness > 0
    ? (completeness * 1000 / avgLatencyMs) * Math.max(0.1, 1 - 0.05 * openGapPenalty)
    : 0;

  return { strategy, results, aggregate: { avgLatencyMs, totalRpc, openGapPenalty, completeness, score } };
}
