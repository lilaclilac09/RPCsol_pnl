/**
 * CMA-ES — Covariance Matrix Adaptation Evolution Strategy
 *
 * Population-based search that adapts both the step size (σ) and the full
 * covariance matrix (C) of a multivariate normal distribution. Discovers
 * correlations between parameters automatically — e.g. "small anchor AND
 * high concurrency both help together".
 *
 * Algorithm (simplified (1+λ)-CMA-ES):
 *   1. Sample λ candidates from N(mean, σ²C)
 *   2. Evaluate all λ in parallel
 *   3. Update mean toward weighted centroid of top-μ candidates
 *   4. Update C from the step directions of top-μ
 *   5. Adapt σ via cumulative path length control
 *   6. Repeat for G generations
 *
 * Parameter space (5D continuous, integers rounded at eval):
 *   [0] anchorSize      [10, 100]
 *   [1] windowSize      [20, 100]
 *   [2] maxConcurrency  [4,  24]
 *   [3] useContinuityOracle  [0, 1] → bool at 0.5 threshold
 *   [4] skipZeroDelta        [0, 1] → bool at 0.5 threshold
 *
 * Usage:
 *   node research_cmaes.mjs <api-key> [generations=8] [lambda=8]
 */

import { writeFileSync, mkdirSync } from "fs";
import { evaluate } from "./eval_v2.mjs";

const apiKey      = process.argv[2] ?? process.env.HELIUS_API_KEY;
const GENERATIONS = parseInt(process.argv[3] ?? "8",  10);
const LAMBDA      = parseInt(process.argv[4] ?? "8",  10);  // population size

if (!apiKey) { console.error("Usage: node research_cmaes.mjs <api-key> [gen=8] [lambda=8]"); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// Parameter space
// ─────────────────────────────────────────────────────────────────────────────

const PARAMS = [
  { name: "anchorSize",          lo: 10, hi: 100 },
  { name: "windowSize",          lo: 20, hi: 100 },
  { name: "maxConcurrency",      lo: 4,  hi: 24  },
  { name: "useContinuityOracle", lo: 0,  hi: 1   },
  { name: "skipZeroDelta",       lo: 0,  hi: 1   },
];
const N   = PARAMS.length;
const MU  = Math.floor(LAMBDA / 2);   // number of parents (top-half)
const FIXED = { sigPageSize: 1000, maxSigPages: 20 };

// Normalise continuous [0,1] → actual strategy values
function decode(z) {
  const s = { ...FIXED };
  for (let i = 0; i < N; i++) {
    const p = PARAMS[i];
    const v = z[i] * (p.hi - p.lo) + p.lo;
    if (p.hi === 1) s[p.name] = v > 0.5;           // boolean
    else            s[p.name] = Math.round(v);      // integer
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Linear algebra helpers (pure JS, no deps)
// ─────────────────────────────────────────────────────────────────────────────

const zeros = n => Array.from({ length: n }, () => 0);
const eye   = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1 : 0));
const dot   = (a, b) => a.reduce((s, ai, i) => s + ai * b[i], 0);
const scale = (v, c) => v.map(x => x * c);
const add   = (a, b) => a.map((x, i) => x + b[i]);
const sub   = (a, b) => a.map((x, i) => x - b[i]);
const outer = (a, b) => a.map(ai => b.map(bi => ai * bi));
const matvec= (M, v) => M.map(row => dot(row, v));

// Cholesky decompose symmetric PD matrix (for sampling)
function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => zeros(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
  }
  return L;
}

// Sample N(0,1) using Box-Muller
function randn() {
  const u = 1 - Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleFromCMA(mean, sigma, L) {
  // z ~ N(0, I)
  const z = Array.from({ length: N }, randn);
  // y = L * z  (sample from N(0, C))
  const y = matvec(L, z);
  // x = mean + sigma * y, clipped to [0,1]
  return mean.map((m, i) => Math.max(0, Math.min(1, m + sigma * y[i])));
}

// ─────────────────────────────────────────────────────────────────────────────
// CMA-ES state
// ─────────────────────────────────────────────────────────────────────────────

// Weights for recombination (log-linear)
const weights = Array.from({ length: MU }, (_, i) =>
  Math.log(MU + 0.5) - Math.log(i + 1)
);
const wSum  = weights.reduce((s, w) => s + w, 0);
weights.forEach((_, i) => { weights[i] /= wSum; });
const muEff = 1 / weights.reduce((s, w) => s + w * w, 0);

// Step-size control (CSA)
const c_sigma = (muEff + 2) / (N + muEff + 5);
const d_sigma = 1 + 2 * Math.max(0, Math.sqrt((muEff - 1) / (N + 1)) - 1) + c_sigma;
const chiN    = Math.sqrt(N) * (1 - 1 / (4 * N) + 1 / (21 * N * N));

// Covariance update
const c_c  = (4 + muEff / N) / (N + 4 + 2 * muEff / N);
const c_1  = 2 / ((N + 1.3) ** 2 + muEff);
const c_mu = Math.min(1 - c_1, 2 * (muEff - 2 + 1 / muEff) / ((N + 2) ** 2 + muEff));

// Initial state
let mean  = PARAMS.map(() => 0.5);                          // start at centre
let sigma = 0.4;                                            // initial step size
let C     = eye(N);                                         // identity covariance
let p_c   = Array.from({ length: N }, () => 0);             // evolution path (cov)
let p_s   = Array.from({ length: N }, () => 0);             // evolution path (step)
let eigenAge = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────

mkdirSync("results_cmaes", { recursive: true });

console.log(`\n🔬 CMA-ES (Covariance Matrix Adaptation)`);
console.log(`   Generations: ${GENERATIONS}  λ=${LAMBDA}  μ=${MU}`);
console.log(`   API key: ${apiKey.slice(0, 8)}...`);

const allResults = [];
let bestScore = 0, bestStrategy = null, bestGen = 0;

for (let gen = 0; gen < GENERATIONS; gen++) {
  // Recompute Cholesky every few generations (eigendecomposition cost)
  if (gen - eigenAge >= 1 || gen === 0) {
    try { C._L = cholesky(C); eigenAge = gen; }
    catch { C = eye(N); C._L = cholesky(C); }  // reset if degenerate
  }
  const L = C._L;

  // Sample λ offspring
  const population = Array.from({ length: LAMBDA }, () => sampleFromCMA(mean, sigma, L));

  console.log(`\n[Gen ${gen + 1}/${GENERATIONS}]  mean=[${mean.map(m => m.toFixed(2)).join(",")}]  σ=${sigma.toFixed(3)}`);

  // Evaluate in parallel batches of 4
  const scored = new Array(LAMBDA);
  const BATCH  = 4;
  for (let i = 0; i < LAMBDA; i += BATCH) {
    const batch = population.slice(i, i + BATCH);
    const evals = await Promise.all(batch.map(async (x) => {
      const strategy = decode(x);
      try {
        const result = await evaluate(strategy, apiKey);
        return result.aggregate.score;
      } catch { return 0; }
    }));
    evals.forEach((score, j) => { scored[i + j] = { x: batch[j], score }; });
    process.stdout.write(`  [${i + BATCH}/${LAMBDA}] `);
    evals.forEach(s => process.stdout.write(`${s.toFixed(3)} `));
    process.stdout.write("\n");
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const genBest = scored[0];
  if (genBest.score > bestScore) {
    bestScore    = genBest.score;
    bestStrategy = decode(genBest.x);
    bestGen      = gen + 1;
    console.log(`  ✅ New best: score=${bestScore.toFixed(4)}`);
    console.log(`     anchor=${bestStrategy.anchorSize}  window=${bestStrategy.windowSize}  c=${bestStrategy.maxConcurrency}`);
  }

  // Log generation
  allResults.push({
    gen: gen + 1,
    mean: [...mean],
    sigma,
    best: { score: genBest.score, strategy: decode(genBest.x) },
    population: scored.map(s => ({ score: s.score, strategy: decode(s.x) })),
  });
  writeFileSync("results_cmaes/log.json", JSON.stringify(allResults, null, 2));

  // ── CMA-ES update ──────────────────────────────────────────────────────────
  const topMu   = scored.slice(0, MU);
  const oldMean = [...mean];

  // 1. Update mean (weighted recombination of top-μ)
  mean = zeros(N);
  for (let i = 0; i < MU; i++) {
    mean = add(mean, scale(topMu[i].x, weights[i]));
  }

  // 2. Cumulative step-size adaptation (CSA)
  const C_inv_sqrt_dm = matvec(
    C.map(row => row.map(v => v)),  // C^{-1/2} ≈ identity for simplicity
    sub(mean, oldMean).map(v => v / sigma)
  );
  p_s = add(scale(p_s, 1 - c_sigma),
            scale(C_inv_sqrt_dm, Math.sqrt(c_sigma * (2 - c_sigma) * muEff)));
  sigma *= Math.exp((c_sigma / d_sigma) * (Math.sqrt(dot(p_s, p_s)) / chiN - 1));
  sigma  = Math.max(0.05, Math.min(0.5, sigma));  // keep reasonable bounds

  // 3. Covariance matrix adaptation (CMA)
  const hsig = Math.sqrt(dot(p_s, p_s)) / chiN < 1.4 + 2 / (N + 1) ? 1 : 0;
  const dm   = sub(mean, oldMean).map(v => v / sigma);
  p_c = add(scale(p_c, 1 - c_c),
            scale(dm, hsig * Math.sqrt(c_c * (2 - c_c) * muEff)));

  // Rank-μ update to covariance
  const rank1 = outer(p_c, p_c);
  const rankMu = Array.from({ length: N }, () => zeros(N));
  for (let k = 0; k < MU; k++) {
    const step = sub(topMu[k].x, oldMean).map(v => v / sigma);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
      rankMu[i][j] += weights[k] * step[i] * step[j];
  }

  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    C[i][j] = (1 - c_1 - c_mu) * C[i][j]
            + c_1 * rank1[i][j]
            + c_mu * rankMu[i][j];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log("CMA-ES COMPLETE");
console.log(`${"═".repeat(60)}`);
console.log(`\nBest config found (gen ${bestGen}):`);
console.log(JSON.stringify(bestStrategy, null, 2));
console.log(`Score: ${bestScore.toFixed(4)}`);

if (bestStrategy) {
  writeFileSync("results_cmaes/best_strategy.json", JSON.stringify({
    _meta: { method: "cmaes", gen: bestGen, score: bestScore },
    ...bestStrategy,
  }, null, 2));
}

console.log("\nBest per generation:");
for (const g of allResults) {
  console.log(`  Gen ${String(g.gen).padStart(2)}  score=${g.best.score.toFixed(4)}  σ=${g.sigma.toFixed(3)}` +
    `  anchor=${g.best.strategy.anchorSize}  window=${g.best.strategy.windowSize}  c=${g.best.strategy.maxConcurrency}`);
}
