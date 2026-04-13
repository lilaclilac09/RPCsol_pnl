/**
 * eval_v13 — constrained objective: ALL wallets must complete under 3000ms
 *
 * Score formula (hard gate + soft optimise):
 *   base  = (completeness * 1000 / avgLatencyMs) * max(0.1, 1 - 0.05 * openGapPenalty)
 *   gate  = if ANY wallet >= 3000ms → multiply by 0.05 (strong penalty)
 *           if ANY wallet >= 2000ms → multiply by 0.60 (soft nudge)
 *           else → 1.0
 *   score = base * gate
 *
 * This forces BO to strongly prefer configs where dense wallet < 2s,
 * while still maximising score within that region.
 */
import { solBalanceOverTime } from "./sol_balance_v11.mjs";

export const TEST_WALLETS = [
  { address: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs", type: "sparse",   expectedMinSamples: 4   },
  { address: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs", type: "medium",   expectedMinSamples: 30  },
  { address: "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n", type: "dense",    expectedMinSamples: 100 },
];

export async function evaluate(strategy, apiKey) {
  const results = [];
  for (const wallet of TEST_WALLETS) {
    try {
      const t0     = performance.now();
      const result = await solBalanceOverTime(wallet.address, apiKey, strategy);
      const wallMs = performance.now() - t0;
      results.push({ wallet: wallet.address, type: wallet.type, wallMs,
                     rpcCalls: result.stats.totalRpcCalls, sampleCount: result.stats.sampleCount,
                     openGaps: result.stats.openGapsRemaining,
                     complete: result.stats.sampleCount >= wallet.expectedMinSamples });
    } catch (err) {
      results.push({ wallet: wallet.address, type: wallet.type, wallMs: 120000,
                     rpcCalls: 60, sampleCount: 0, openGaps: 99, complete: false, error: err.message });
    }
  }
  const avgLatencyMs   = results.reduce((s, r) => s + r.wallMs,   0) / results.length;
  const maxWalletMs    = Math.max(...results.map(r => r.wallMs));
  const totalRpc       = results.reduce((s, r) => s + r.rpcCalls, 0);
  const openGapPenalty = results.reduce((s, r) => s + r.openGaps, 0);
  const completeness   = results.filter(r => r.complete).length / results.length;

  // Hard gate: penalise heavily if any wallet >= limit
  const gate = maxWalletMs >= 3000 ? 0.05
             : maxWalletMs >= 2000 ? 0.60
             : 1.0;

  const score = completeness > 0
    ? (completeness * 1000 / avgLatencyMs) * Math.max(0.1, 1 - 0.05 * openGapPenalty) * gate
    : 0;

  return { strategy, results, aggregate: { avgLatencyMs, maxWalletMs, totalRpc, openGapPenalty, completeness, score, gate } };
}
