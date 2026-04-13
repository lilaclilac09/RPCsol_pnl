/**
 * Bayesian Optimisation — GP-UCB for V11 (Hybrid Density + Ultra Low Latency)
 *
 * V11 = V4 density probe for large wallets + V10 streaming/fast-exit for small/medium.
 *
 * Parameters to tune:
 *   windowSize     [20, 100]  — affects Phase 1 window granularity (small/medium wallets)
 *   windowTarget   [40, 120]  — target txns/window for density probe (large wallets)
 *   maxConcurrency [4,  32]   — parallel throughput
 *   skipZeroDelta  {0,  1}    — affects all wallets
 *
 * anchor fixed at 100 (maximises fast-exit hit rate).
 *
 * Usage:
 *   node research_bayes_v11.mjs <api-key> [budget=40]
 */

import { writeFileSync, mkdirSync } from "fs";
import { evaluate } from "./eval_v11.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const BUDGET = parseInt(process.argv[3] ?? "40", 10);

if (!apiKey) { console.error("Usage: node research_bayes_v11.mjs <api-key> [budget=40]"); process.exit(1); }

const PARAMS = [
  { name: "windowSize",     lo: 20,  hi: 100, integer: true  },
  { name: "windowTarget",   lo: 40,  hi: 120, integer: true  },
  { name: "maxConcurrency", lo: 4,   hi: 32,  integer: true  },
  { name: "skipZeroDelta",  lo: 0,   hi: 1,   boolean: true  },
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
  for (let i = 0; i < n; i++) { let s = b[i]; for (let j = 0; j < i; j++) s -= L[i][j] * y[j]; y[i] = s / L[i][i]; }
  return y;
}

function solveLT(L, y) {
  const n = y.length, x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let j = i + 1; j < n; j++) s -= L[j][i] * x[j]; x[i] = s / L[i][i]; }
  return x;
}

class GP {
  constructor() {
    this.ls = new Float64Array(DIM).fill(0.5); this.sv = 1.0; this.nv = 0.01;
    this.Xs = []; this.ys = []; this.yMean = 0; this.yStd = 1;
  }
  fit(Xs, ys) {
    this.Xs = Xs;
    this.yMean = ys.reduce((s, y) => s + y, 0) / ys.length;
    const v   = ys.reduce((s, y) => s + (y - this.yMean) ** 2, 0) / ys.length;
    this.yStd = Math.sqrt(v) || 1;
    this.ys   = ys.map(y => (y - this.yMean) / this.yStd);
    const n   = Xs.length;
    const K   = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => rbfKernel(Xs[i], Xs[j], this.ls, this.sv) + (i === j ? this.nv : 0)));
    this.L     = cholesky(K);
    this.alpha = solveLT(this.L, solveL(this.L, this.ys));
  }
  predict(x) {
    if (!this.Xs.length) return { mean: 0, std: 1 };
    const ks   = this.Xs.map(xi => rbfKernel(xi, x, this.ls, this.sv));
    const mean = ks.reduce((s, k, i) => s + k * this.alpha[i], 0);
    const v    = solveL(this.L, ks);
    const var_ = Math.max(0, rbfKernel(x, x, this.ls, this.sv) - v.reduce((s, vi) => s + vi * vi, 0));
    return { mean: mean * this.yStd + this.yMean, std: Math.sqrt(var_) * this.yStd };
  }
}

function suggest(gp, kappa) {
  let bestX = null, bestAcq = -Infinity;
  for (let i = 0; i < 400; i++) {
    const x   = randomX();
    const { mean, std } = gp.predict(x);
    const acq = mean + kappa * std;
    if (acq > bestAcq) { bestAcq = acq; bestX = x; }
  }
  return bestX;
}

mkdirSync("results_bayes_v11", { recursive: true });
console.log(`\nBayesian Optimisation (GP-UCB) — V11 Hybrid\n   Budget: ${BUDGET}  |  4D  |  ${apiKey.slice(0, 8)}...`);
console.log(`   anchor=100 fixed. V4 density probe for large wallets. V10 fast-exit for small/medium.`);

const gp = new GP(), Xs = [], ys = [], logs = [];

for (let trial = 0; trial < BUDGET; trial++) {
  const kappa    = 2.0 * Math.pow(0.9, trial);
  const x        = trial < 6 ? randomX() : suggest(gp, kappa);
  const strategy = xToStrategy(x);

  console.log(`\n[BO-V11 trial ${trial + 1}/${BUDGET}  k=${kappa.toFixed(2)}]`);
  console.log(`  window=${strategy.windowSize}  target=${strategy.windowTarget}  c=${strategy.maxConcurrency}  skip=${strategy.skipZeroDelta}`);

  let score = 0;
  try {
    const result = await evaluate(strategy, apiKey);
    score = result.aggregate.score;
    const pw = result.results.map(r => `${r.type[0]}:${r.wallMs.toFixed(0)}ms`).join("  ");
    console.log(`  -> score=${score.toFixed(4)}  avgMs=${result.aggregate.avgLatencyMs.toFixed(0)}  rpc=${result.aggregate.totalRpc}  [${pw}]`);
    logs.push({ trial: trial + 1, x, strategy, score, aggregate: result.aggregate, results: result.results });
  } catch (err) {
    console.log(`  -> ERROR: ${err.message}`);
    logs.push({ trial: trial + 1, x, strategy, score: 0, error: err.message });
  }

  Xs.push(x); ys.push(score);
  if (Xs.length >= 2) gp.fit(Xs, ys);
  writeFileSync("results_bayes_v11/log.json", JSON.stringify(logs, null, 2));
}

const best = logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score)[0];
console.log(`\n${"=".repeat(60)}\nBAYESIAN OPTIMISATION V11 COMPLETE\n${"=".repeat(60)}`);
console.log(`Best (trial ${best?.trial}):`, JSON.stringify(best?.strategy));
console.log(`Score: ${best?.score?.toFixed(4)}  avgMs: ${best?.aggregate?.avgLatencyMs?.toFixed(0)}`);
if (best?.results) best.results.forEach(r => console.log(`  ${r.type}: ${r.wallMs.toFixed(0)}ms ${r.rpcCalls} calls`));

if (best) writeFileSync("results_bayes_v11/best_strategy.json", JSON.stringify({
  _meta: { method: "bayesian-gp-ucb-v11-hybrid", trial: best.trial, score: best.score,
           note: "V4 density probe for large wallets + V10 fast-exit for small/medium" },
  ...best.strategy,
}, null, 2));

console.log("\nTop 5:");
for (const r of logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score).slice(0, 5))
  console.log(`  #${r.trial}  score=${r.score.toFixed(4)}  window=${r.strategy.windowSize}  target=${r.strategy.windowTarget}  c=${r.strategy.maxConcurrency}  skip=${r.strategy.skipZeroDelta}  ${r.aggregate?.avgLatencyMs?.toFixed(0)}ms`);
