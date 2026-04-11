/**
 * Evaluation harness for the autoresearch loop.
 *
 * Runs sol_balance.mjs against a fixed set of test wallets and scores
 * the result on: wall time, API call count, and sample completeness.
 *
 * Used by agent.mjs (each independent agent) and coordinator.mjs.
 *
 * Scoring:
 *   score = 1 / (avg_latency_ms / 1000)   (higher is better)
 *   Penalise open gaps: score *= (1 - 0.1 * openGapsRemaining)
 */

import { solBalanceOverTime } from "./sol_balance.mjs";

export const TEST_WALLETS = [
  // sparse — 4 txns, completes in one round trip
  { address: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs", type: "sparse",   expectedMinSamples: 4  },
  // medium — ~60 txns
  { address: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs", type: "medium",   expectedMinSamples: 30 },
  // dense — 451+ txns
  { address: "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n", type: "dense",    expectedMinSamples: 100},
];

/**
 * Run one strategy config against all test wallets.
 * Returns per-wallet results and an aggregate score.
 */
export async function evaluate(strategy, apiKey, { timeout = 120_000 } = {}) {
  const results = [];

  for (const wallet of TEST_WALLETS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);

    try {
      const t0     = performance.now();
      const result = await solBalanceOverTime(wallet.address, apiKey, strategy);
      const wallMs = performance.now() - t0;

      const complete = result.stats.sampleCount >= wallet.expectedMinSamples;
      results.push({
        wallet:        wallet.address,
        type:          wallet.type,
        wallMs,
        rpcCalls:      result.stats.totalRpcCalls,
        sampleCount:   result.stats.sampleCount,
        continuityHits: result.stats.resolvedByContinuity,
        openGaps:      result.stats.openGapsRemaining,
        complete,
      });
    } catch (err) {
      results.push({
        wallet:   wallet.address,
        type:     wallet.type,
        wallMs:   timeout,
        rpcCalls: strategy.maxRpcCalls,
        sampleCount: 0,
        openGaps: 99,
        complete: false,
        error:    err.message,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Aggregate scoring
  const avgLatencyMs = results.reduce((s, r) => s + r.wallMs, 0) / results.length;
  const totalRpc     = results.reduce((s, r) => s + r.rpcCalls, 0);
  const openGapPenalty = results.reduce((s, r) => s + r.openGaps, 0);
  const completeness = results.filter(r => r.complete).length / results.length;

  // Score: higher is better
  // Primary: minimise latency. Secondary: penalise open gaps. Must be complete.
  const score = completeness > 0
    ? (completeness * 1000 / avgLatencyMs) * Math.max(0.1, 1 - 0.05 * openGapPenalty)
    : 0;

  return {
    strategy,
    results,
    aggregate: { avgLatencyMs, totalRpc, openGapPenalty, completeness, score },
  };
}
