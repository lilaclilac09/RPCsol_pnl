/**
 * Bayesian Optimisation — GP-UCB for V3 (merged anchor-sig)
 *
 * Same GP-UCB approach as research_bayes.mjs but tuned for V3's 4D parameter
 * space (useContinuityOracle removed — V3 has no oracle).
 *
 * Parameter space:
 *   x[0] anchorSize     [10, 100]
 *   x[1] windowSize     [20, 100]
 *   x[2] maxConcurrency [4,  24]
 *   x[3] skipZeroDelta  {0, 1}
 *
 * Usage:
 *   node research_bayes_v3.mjs <api-key> [budget=40]
 */

import { writeFileSync, mkdirSync } from "fs";
import { evaluate } from "./eval_v3.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const BUDGET = parseInt(process.argv[3] ?? "40", 10);

if (!apiKey) { console.error("Usage: node research_bayes_v3.mjs <api-key> [budget=40]"); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// Parameter space
// ─────────────────────────────────────────────────────────────────────────────

const PARAMS = [
  { name: "anchorSize",     lo: 10, hi: 100, integer: true  },
  { name: "windowSize",     lo: 20, hi: 100, integer: true  },
  { name: "maxConcurrency", lo: 4,  hi: 24,  integer: true  },
  { name: "skipZeroDelta",  lo: 0,  hi: 1,   boolean: true  },
];
const DIM   = PARAMS.length;
const FIXED = { sigPageSize: 1000, maxSigPages: 20 };

function xToStrategy(x) {
  const s = { ...FIXED };
  for (let i = 0; i < DIM; i++) {
    const p = PARAMS[i];
    const v = x[i] * (p.hi - p.lo) + p.lo;
    s[p.name] = p.boolean ? v > 0.5 : Math.round(v);
  }
  return s;
}

function randomX() { return PARAMS.map(() => Math.random()); }

// ─────────────────────────────────────────────────────────────────────────────
// Gaussian Process (RBF kernel, noise-aware) — pure JS, no deps
// ─────────────────────────────────────────────────────────────────────────────

function rbfKernel(a, b, ls, sv) {
  let sq = 0;
  for (let i = 0; i < a.length; i++) { const d = (a[i] - b[i]) / ls[i]; sq += d * d; }
  return sv * Math.exp(-0.5 * sq);
}

function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-10)) : s / L[j][j];
    }
  }
  return L;
}

function solveL(L, b) {
  const n = b.length, y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let j = 0; j < i; j++) s -= L[i][j] * y[j];
    y[i] = s / L[i][i];
  }
  return y;
}

function solveLT(L, y) {
  const n = y.length, x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let j = i + 1; j < n; j++) s -= L[j][i] * x[j];
    x[i] = s / L[i][i];
  }
  return x;
}

class GaussianProcess {
  constructor() {
    this.lengthScales = new Float64Array(DIM).fill(0.5);
    this.signalVar    = 1.0;
    this.noiseVar     = 0.01;
    this.Xs = []; this.ys = [];
    this.yMean = 0; this.yStd = 1;
  }

  fit(Xs, ys) {
    this.Xs    = Xs;
    this.yMean = ys.reduce((s, y) => s + y, 0) / ys.length;
    const var_ = ys.reduce((s, y) => s + (y - this.yMean) ** 2, 0) / ys.length;
    this.yStd  = Math.sqrt(var_) || 1;
    this.ys    = ys.map(y => (y - this.yMean) / this.yStd);
    const n    = Xs.length;
    const K    = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) =>
        rbfKernel(Xs[i], Xs[j], this.lengthScales, this.signalVar) + (i === j ? this.noiseVar : 0)
      )
    );
    this.L     = cholesky(K);
    this.alpha = solveLT(this.L, solveL(this.L, this.ys));
  }

  predict(x) {
    if (this.Xs.length === 0) return { mean: 0, std: 1 };
    const ks   = this.Xs.map(xi => rbfKernel(xi, x, this.lengthScales, this.signalVar));
    const mean = ks.reduce((s, k, i) => s + k * this.alpha[i], 0);
    const v    = solveL(this.L, ks);
    const var_ = Math.max(0, rbfKernel(x, x, this.lengthScales, this.signalVar) - v.reduce((s, vi) => s + vi * vi, 0));
    return { mean: mean * this.yStd + this.yMean, std: Math.sqrt(var_) * this.yStd };
  }
}

function ucb(gp, x, kappa) {
  const { mean, std } = gp.predict(x);
  return mean + kappa * std;
}

function suggestNext(gp, kappa, numRestarts = 200) {
  let bestX = null, bestAcq = -Infinity;
  for (let i = 0; i < numRestarts; i++) {
    const x   = randomX();
    const acq = ucb(gp, x, kappa);
    if (acq > bestAcq) { bestAcq = acq; bestX = x; }
  }
  return bestX;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────

mkdirSync("results_bayes_v3", { recursive: true });

console.log(`\n🔬 Bayesian Optimisation (GP-UCB) — V3`);
console.log(`   Budget: ${BUDGET} evals  |  Params: ${DIM}D  |  API key: ${apiKey.slice(0, 8)}...`);

const gp   = new GaussianProcess();
const Xs   = [];
const ys   = [];
const logs = [];
const WARMUP = 5;

for (let trial = 0; trial < BUDGET; trial++) {
  const kappa    = 2.0 * Math.pow(0.9, trial);
  const x        = trial < WARMUP ? randomX() : suggestNext(gp, kappa);
  const strategy = xToStrategy(x);

  console.log(`\n[BO-V3 trial ${trial + 1}/${BUDGET}  κ=${kappa.toFixed(2)}]`);
  console.log(`  anchor=${strategy.anchorSize}  window=${strategy.windowSize}` +
    `  c=${strategy.maxConcurrency}  skipZero=${strategy.skipZeroDelta}`);

  let score = 0;
  try {
    const result = await evaluate(strategy, apiKey);
    score = result.aggregate.score;
    console.log(`  → score=${score.toFixed(4)}  avgMs=${result.aggregate.avgLatencyMs.toFixed(0)}` +
      `  rpc=${result.aggregate.totalRpc}  complete=${(result.aggregate.completeness * 100).toFixed(0)}%`);
    logs.push({ trial: trial + 1, x, strategy, score, aggregate: result.aggregate });
  } catch (err) {
    console.log(`  → ERROR: ${err.message}`);
    logs.push({ trial: trial + 1, x, strategy, score: 0, error: err.message });
  }

  Xs.push(x);
  ys.push(score);
  if (Xs.length >= 2) gp.fit(Xs, ys);

  writeFileSync("results_bayes_v3/log.json", JSON.stringify(logs, null, 2));
}

const best = logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score)[0];

console.log(`\n${"═".repeat(60)}`);
console.log("BAYESIAN OPTIMISATION V3 COMPLETE");
console.log(`${"═".repeat(60)}`);
console.log(`\nBest config found (trial ${best?.trial}):`);
console.log(JSON.stringify(best?.strategy, null, 2));
console.log(`Score: ${best?.score?.toFixed(4)}  avgMs: ${best?.aggregate?.avgLatencyMs?.toFixed(0)}`);

if (best) {
  writeFileSync("results_bayes_v3/best_strategy.json", JSON.stringify({
    _meta: { method: "bayesian-gp-ucb-v3", trial: best.trial, score: best.score,
             avgMs: best.aggregate?.avgLatencyMs },
    ...best.strategy,
  }, null, 2));
}

console.log("\nTop 10:");
for (const r of logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score).slice(0, 10)) {
  console.log(`  #${String(r.trial).padStart(2)}  score=${r.score.toFixed(4)}` +
    `  anchor=${r.strategy.anchorSize}  window=${r.strategy.windowSize}` +
    `  c=${r.strategy.maxConcurrency}  ${r.aggregate?.avgLatencyMs?.toFixed(0)}ms`);
}
