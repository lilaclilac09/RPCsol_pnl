/**
 * Bayesian Optimisation — GP-UCB
 *
 * Maintains a Gaussian Process surrogate over the V2 strategy score landscape.
 * At each step:
 *   1. Fit GP to all (x, score) observations so far
 *   2. Use UCB acquisition to pick the most promising untried config
 *   3. Evaluate that config against all 3 test wallets
 *   4. Add result to observations, repeat
 *
 * Parameter space (continuous encoding):
 *   x[0] anchorSize      [10, 100]
 *   x[1] windowSize      [20, 100]
 *   x[2] maxConcurrency  [4,  24]
 *   x[3] useContinuityOracle  {0, 1}
 *   x[4] skipZeroDelta        {0, 1}
 *
 * No external dependencies — GP inference in pure JS.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { evaluate } from "./eval_v2.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const BUDGET = parseInt(process.argv[3] ?? "40", 10);  // total evals

if (!apiKey) { console.error("Usage: node research_bayes.mjs <api-key> [budget=40]"); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// Parameter space definition
// ─────────────────────────────────────────────────────────────────────────────

const PARAMS = [
  { name: "anchorSize",          lo: 10,  hi: 100, integer: true  },
  { name: "windowSize",          lo: 20,  hi: 100, integer: true  },
  { name: "maxConcurrency",      lo: 4,   hi: 24,  integer: true  },
  { name: "useContinuityOracle", lo: 0,   hi: 1,   boolean: true  },
  { name: "skipZeroDelta",       lo: 0,   hi: 1,   boolean: true  },
];
const DIM = PARAMS.length;
const FIXED = { sigPageSize: 1000, maxSigPages: 20 };

function xToStrategy(x) {
  const s = { ...FIXED };
  for (let i = 0; i < DIM; i++) {
    const p = PARAMS[i];
    const v = x[i] * (p.hi - p.lo) + p.lo;
    s[p.name] = p.boolean ? v > 0.5 : (p.integer ? Math.round(v) : v);
  }
  return s;
}

function randomX() {
  return PARAMS.map(() => Math.random());
}

// ─────────────────────────────────────────────────────────────────────────────
// Gaussian Process (RBF kernel, noise-aware)
// ─────────────────────────────────────────────────────────────────────────────

// RBF kernel: k(a,b) = exp(-0.5 * sum((a_i - b_i)^2 / l_i^2))
// Length scales l_i are learnable via log-marginal likelihood.

function rbfKernel(a, b, lengthScales, signalVar) {
  let sq = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] - b[i]) / lengthScales[i];
    sq += diff * diff;
  }
  return signalVar * Math.exp(-0.5 * sq);
}

// Cholesky decomposition of a symmetric positive-definite matrix
function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-10)) : sum / L[j][j];
    }
  }
  return L;
}

// Solve L * y = b (forward substitution)
function solveL(L, b) {
  const n = b.length, y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let j = 0; j < i; j++) s -= L[i][j] * y[j];
    y[i] = s / L[i][i];
  }
  return y;
}

// Solve L^T * x = y (back substitution)
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
    this.Xs           = [];    // observed inputs (normalised)
    this.ys           = [];    // observed outputs (normalised)
    this.yMean        = 0;
    this.yStd         = 1;
  }

  fit(Xs, ys) {
    this.Xs = Xs;
    // Normalise outputs to zero mean, unit variance
    this.yMean = ys.reduce((s, y) => s + y, 0) / ys.length;
    const variance = ys.reduce((s, y) => s + (y - this.yMean) ** 2, 0) / ys.length;
    this.yStd  = Math.sqrt(variance) || 1;
    this.ys    = ys.map(y => (y - this.yMean) / this.yStd);
    this._buildKernel();
  }

  _buildKernel() {
    const n   = this.Xs.length;
    const K   = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) =>
        rbfKernel(this.Xs[i], this.Xs[j], this.lengthScales, this.signalVar) +
        (i === j ? this.noiseVar : 0)
      )
    );
    this.L    = cholesky(K);
    this.alpha = solveLT(this.L, solveL(this.L, this.ys));
  }

  predict(x) {
    if (this.Xs.length === 0) return { mean: 0, std: 1 };
    const n  = this.Xs.length;
    const ks = this.Xs.map(xi => rbfKernel(xi, x, this.lengthScales, this.signalVar));
    const mean = ks.reduce((s, k, i) => s + k * this.alpha[i], 0);
    const v    = solveL(this.L, ks);
    const var_ = Math.max(0,
      rbfKernel(x, x, this.lengthScales, this.signalVar) -
      v.reduce((s, vi) => s + vi * vi, 0)
    );
    return {
      mean: mean * this.yStd + this.yMean,
      std:  Math.sqrt(var_) * this.yStd,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UCB acquisition function
// ─────────────────────────────────────────────────────────────────────────────

// κ decreases over time to shift from explore to exploit
function ucb(gp, x, kappa = 2.0) {
  const { mean, std } = gp.predict(x);
  return mean + kappa * std;
}

// Maximise UCB by random restart gradient-free optimisation
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

mkdirSync("results_bayes", { recursive: true });

console.log(`\n🔬 Bayesian Optimisation (GP-UCB)`);
console.log(`   Budget: ${BUDGET} evals  |  Params: ${DIM}  |  API key: ${apiKey.slice(0, 8)}...`);

const gp   = new GaussianProcess();
const Xs   = [];
const ys   = [];
const logs = [];

// Warm-up: 5 random evaluations before GP kicks in
const WARMUP = 5;

for (let trial = 0; trial < BUDGET; trial++) {
  const kappa = 2.0 * Math.pow(0.9, trial);  // decay exploration over time

  // Pick next point
  const x = trial < WARMUP
    ? randomX()
    : suggestNext(gp, kappa);

  const strategy = xToStrategy(x);

  console.log(`\n[BO trial ${trial + 1}/${BUDGET}  κ=${kappa.toFixed(2)}]`);
  console.log(`  anchorSize=${strategy.anchorSize}  windowSize=${strategy.windowSize}` +
    `  concurrency=${strategy.maxConcurrency}` +
    `  oracle=${strategy.useContinuityOracle}  skipZero=${strategy.skipZeroDelta}`);

  let score = 0;
  try {
    const t0     = performance.now();
    const result = await evaluate(strategy, apiKey);
    const wallMs = performance.now() - t0;
    score = result.aggregate.score;

    console.log(`  → score=${score.toFixed(4)}  avgMs=${result.aggregate.avgLatencyMs.toFixed(0)}  rpc=${result.aggregate.totalRpc}  complete=${(result.aggregate.completeness*100).toFixed(0)}%`);

    logs.push({ trial: trial + 1, x, strategy, score, aggregate: result.aggregate });
  } catch (err) {
    console.log(`  → ERROR: ${err.message}`);
    logs.push({ trial: trial + 1, x, strategy, score: 0, error: err.message });
  }

  Xs.push(x);
  ys.push(score);
  if (Xs.length >= 2) gp.fit(Xs, ys);

  writeFileSync("results_bayes/log.json", JSON.stringify(logs, null, 2));
}

// Best found
const best = logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score)[0];

console.log(`\n${"═".repeat(60)}`);
console.log("BAYESIAN OPTIMISATION COMPLETE");
console.log(`${"═".repeat(60)}`);
console.log(`\nBest config found (trial ${best?.trial}):`);
console.log(JSON.stringify(best?.strategy, null, 2));
console.log(`Score: ${best?.score?.toFixed(4)}  avgMs: ${best?.aggregate?.avgLatencyMs?.toFixed(0)}`);

// Write best strategy
if (best) {
  writeFileSync("results_bayes/best_strategy.json", JSON.stringify({
    _meta: { method: "bayesian-gp-ucb", trial: best.trial, score: best.score },
    ...best.strategy,
  }, null, 2));
}

// Leaderboard
console.log("\nTop 10:");
for (const r of logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score).slice(0, 10)) {
  console.log(
    `  #${String(r.trial).padStart(2)}  score=${r.score.toFixed(4)}` +
    `  anchor=${r.strategy.anchorSize}  window=${r.strategy.windowSize}` +
    `  c=${r.strategy.maxConcurrency}  ${r.aggregate?.avgLatencyMs?.toFixed(0)}ms`
  );
}
