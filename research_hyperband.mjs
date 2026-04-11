/**
 * Hyperband — Successive Halving with Multi-Fidelity Evaluation
 *
 * Key idea: don't waste budget evaluating all configs at full cost.
 * Run many cheap evals first; only promote survivors to more expensive evals.
 *
 * Fidelity levels for this problem:
 *   Low   (budget=1): evaluate only the SPARSE wallet  (~2 calls, ~2s)
 *   Mid   (budget=2): evaluate SPARSE + MEDIUM wallets (~4 calls, ~4s)
 *   Full  (budget=3): evaluate all 3 wallets            (~14 calls, ~8s)
 *
 * Hyperband bracket (η=3, s_max=2):
 *   Bracket 0: 9 configs × low fidelity → keep 3 → mid fidelity → keep 1 → full
 *   Bracket 1: 3 configs × mid fidelity → keep 1 → full
 *   Bracket 2: 1 config  × full fidelity (random config evaluated at full budget)
 *
 * Total: ~9+3+1 = 13 full-fidelity-equivalent evals (much cheaper than 13 full evals).
 *
 * Usage:
 *   node research_hyperband.mjs <api-key> [rounds=3]
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { solBalanceOverTime } from "./sol_balance_v2.mjs";

const apiKey  = process.argv[2] ?? process.env.HELIUS_API_KEY;
const ROUNDS  = parseInt(process.argv[3] ?? "3", 10);  // Hyperband outer rounds

if (!apiKey) { console.error("Usage: node research_hyperband.mjs <api-key> [rounds=3]"); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// Fidelity-aware eval: evaluate on subset of wallets
// ─────────────────────────────────────────────────────────────────────────────

const ALL_WALLETS = [
  { address: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs", type: "sparse",   expectedMinSamples: 4   },
  { address: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs", type: "medium",   expectedMinSamples: 30  },
  { address: "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n", type: "dense",    expectedMinSamples: 100 },
];

async function evalFidelity(strategy, fidelity) {
  // fidelity 1=sparse only, 2=sparse+medium, 3=all
  const wallets = ALL_WALLETS.slice(0, fidelity);
  const results = [];

  for (const w of wallets) {
    try {
      const t0     = performance.now();
      const result = await solBalanceOverTime(w.address, apiKey, strategy);
      const wallMs = performance.now() - t0;
      results.push({
        type:        w.type,
        wallMs,
        rpcCalls:    result.stats.totalRpcCalls,
        sampleCount: result.stats.sampleCount,
        complete:    result.stats.sampleCount >= w.expectedMinSamples,
        openGaps:    result.stats.openGapsRemaining,
      });
    } catch (err) {
      results.push({ type: w.type, wallMs: 120_000, rpcCalls: 60, sampleCount: 0, complete: false, openGaps: 99 });
    }
  }

  const avgMs       = results.reduce((s, r) => s + r.wallMs,   0) / results.length;
  const openPenalty = results.reduce((s, r) => s + r.openGaps, 0);
  const completeness= results.filter(r => r.complete).length / results.length;
  const score       = completeness > 0
    ? (completeness * 1000 / avgMs) * Math.max(0.1, 1 - 0.05 * openPenalty)
    : 0;

  return { results, avgMs, completeness, score, fidelity };
}

// ─────────────────────────────────────────────────────────────────────────────
// Random config generation
// ─────────────────────────────────────────────────────────────────────────────

function randomConfig() {
  const anchorSize     = Math.round(10  + Math.random() * 90);   // [10, 100]
  const windowSize     = Math.round(20  + Math.random() * 80);   // [20, 100]
  const maxConcurrency = Math.round(4   + Math.random() * 20);   // [4,  24]
  const useContinuityOracle = Math.random() > 0.3;               // 70% true
  const skipZeroDelta       = Math.random() > 0.2;               // 80% true
  return { anchorSize, windowSize, maxConcurrency, useContinuityOracle, skipZeroDelta,
           sigPageSize: 1000, maxSigPages: 20 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Successive Halving bracket
// ─────────────────────────────────────────────────────────────────────────────

async function successiveHalving(configs, startFidelity, eta = 3) {
  let current  = configs.map(cfg => ({ cfg, score: 0, results: [] }));
  let fidelity = startFidelity;

  while (current.length > 1 && fidelity <= 3) {
    console.log(`\n  [SHA] fidelity=${fidelity}  configs=${current.length}`);

    // Evaluate all current configs at this fidelity in batches of 4
    const BATCH = 4;
    for (let i = 0; i < current.length; i += BATCH) {
      const batch = current.slice(i, i + BATCH);
      const evals = await Promise.all(
        batch.map(item => evalFidelity(item.cfg, fidelity))
      );
      evals.forEach((e, j) => {
        batch[j].score   = e.score;
        batch[j].results = e;
      });
    }

    // Sort and keep top 1/η
    current.sort((a, b) => b.score - a.score);
    const keep = Math.max(1, Math.floor(current.length / eta));
    console.log(`  [SHA] Scores: ${current.map(c => c.score.toFixed(3)).join(", ")}`);
    console.log(`  [SHA] Keeping top ${keep}: ${current.slice(0, keep).map(c => c.score.toFixed(3)).join(", ")}`);
    current  = current.slice(0, keep);
    fidelity++;
  }

  // Final eval at full fidelity for the single survivor if not already there
  if (fidelity <= 3 || current[0].results?.fidelity < 3) {
    const e = await evalFidelity(current[0].cfg, 3);
    current[0].score   = e.score;
    current[0].results = e;
  }

  return current[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Hyperband: run multiple brackets with different n_i / r_i
// ─────────────────────────────────────────────────────────────────────────────

mkdirSync("results_hyperband", { recursive: true });

console.log(`\n🔬 Hyperband (Successive Halving)`);
console.log(`   Rounds: ${ROUNDS}  η=3  Fidelity levels: 1=sparse, 2=+medium, 3=full`);
console.log(`   API key: ${apiKey.slice(0, 8)}...`);

const allWinners = [];

for (let round = 0; round < ROUNDS; round++) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`HYPERBAND ROUND ${round + 1} / ${ROUNDS}`);
  console.log(`${"═".repeat(60)}`);

  // Bracket 0: 9 configs from fidelity 1
  // Bracket 1: 3 configs from fidelity 2
  // Bracket 2: 1 config  from fidelity 3
  const brackets = [
    { n: 9, startFidelity: 1 },
    { n: 3, startFidelity: 2 },
    { n: 1, startFidelity: 3 },
  ];

  for (let b = 0; b < brackets.length; b++) {
    const { n, startFidelity } = brackets[b];
    console.log(`\n  Bracket ${b}: ${n} random configs starting at fidelity ${startFidelity}`);

    const configs = Array.from({ length: n }, randomConfig);
    const winner  = await successiveHalving(configs, startFidelity);

    console.log(`  Bracket ${b} winner: score=${winner.score.toFixed(4)}`);
    console.log(`    anchor=${winner.cfg.anchorSize}  window=${winner.cfg.windowSize}` +
      `  c=${winner.cfg.maxConcurrency}  oracle=${winner.cfg.useContinuityOracle}`);

    allWinners.push({ round: round + 1, bracket: b, ...winner });
  }

  writeFileSync("results_hyperband/log.json", JSON.stringify(allWinners, null, 2));
}

// Global best
const best = allWinners.sort((a, b) => b.score - a.score)[0];

console.log(`\n${"═".repeat(60)}`);
console.log("HYPERBAND COMPLETE");
console.log(`${"═".repeat(60)}`);
console.log(`\nBest config found (round ${best?.round}, bracket ${best?.bracket}):`);
console.log(JSON.stringify(best?.cfg, null, 2));
console.log(`Score: ${best?.score?.toFixed(4)}  avgMs: ${best?.results?.avgMs?.toFixed(0)}`);

writeFileSync("results_hyperband/best_strategy.json", JSON.stringify({
  _meta: { method: "hyperband", round: best.round, bracket: best.bracket, score: best.score },
  ...best.cfg,
}, null, 2));

console.log("\nAll bracket winners:");
for (const w of allWinners.sort((a, b) => b.score - a.score)) {
  console.log(
    `  R${w.round}B${w.bracket}  score=${w.score.toFixed(4)}` +
    `  anchor=${w.cfg.anchorSize}  window=${w.cfg.windowSize}  c=${w.cfg.maxConcurrency}` +
    `  ${w.results?.avgMs?.toFixed(0)}ms`
  );
}
