/**
 * V14 Constrained — Bayesian GP-UCB (Phantom-Token Fixed)
 *
 * Same objective as V13 (all wallets < 3000ms, maximise score) but running on
 * sol_balance_v14.mjs which fixes the phantom paginationToken bug.
 *
 * With phantom tokens eliminated, dense wallet should drop from ~3000ms to ~1000ms.
 * This allows the search to explore higher concurrency without hitting the 3s gate.
 *
 * Search space:
 *   windowSize     [60, 160] — wider than V13 since we expect the dense wallet to
 *                              complete faster at any window size now
 *   maxConcurrency [8, 48]   — allow lower values since latency is now API-bound, not
 *                              pagination-bound
 *   skipZeroDelta  {0, 1}
 *
 * windowTarget fixed at 100, sigPageSize fixed at 1000, maxSigPages fixed at 20.
 *
 * Usage: node research_v14.mjs <api-key> [budget=60]
 */
import { writeFileSync, mkdirSync } from "fs";
import { evaluate } from "./eval_v14.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const BUDGET = parseInt(process.argv[3] ?? "60", 10);
if (!apiKey) { console.error("Usage: node research_v14.mjs <api-key> [budget=60]"); process.exit(1); }

const PARAMS = [
  { name: "windowSize",     lo: 60,  hi: 160, integer: true  },
  { name: "maxConcurrency", lo: 8,   hi: 48,  integer: true  },
  { name: "skipZeroDelta",  lo: 0,   hi: 1,   boolean: true  },
];
const DIM   = PARAMS.length;
const FIXED = { sigPageSize: 1000, maxSigPages: 20, windowTarget: 100 };

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
  constructor() { this.ls = new Float64Array(DIM).fill(0.5); this.sv = 1.0; this.nv = 0.01; this.Xs = []; this.ys = []; this.yMean = 0; this.yStd = 1; }
  fit(Xs, ys) {
    this.Xs = Xs;
    this.yMean = ys.reduce((s, y) => s + y, 0) / ys.length;
    const v = ys.reduce((s, y) => s + (y - this.yMean) ** 2, 0) / ys.length;
    this.yStd = Math.sqrt(v) || 1;
    this.ys = ys.map(y => (y - this.yMean) / this.yStd);
    const n = Xs.length;
    const K = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => rbfKernel(Xs[i], Xs[j], this.ls, this.sv) + (i === j ? this.nv : 0)));
    this.L = cholesky(K);
    this.alpha = solveLT(this.L, solveL(this.L, this.ys));
  }
  predict(x) {
    if (!this.Xs.length) return { mean: 0, std: 1 };
    const ks = this.Xs.map(xi => rbfKernel(xi, x, this.ls, this.sv));
    const mean = ks.reduce((s, k, i) => s + k * this.alpha[i], 0);
    const v = solveL(this.L, ks);
    const var_ = Math.max(0, rbfKernel(x, x, this.ls, this.sv) - v.reduce((s, vi) => s + vi * vi, 0));
    return { mean: mean * this.yStd + this.yMean, std: Math.sqrt(var_) * this.yStd };
  }
}
function suggest(gp, kappa) {
  let bestX = null, bestAcq = -Infinity;
  for (let i = 0; i < 800; i++) {
    const x = randomX();
    const { mean, std } = gp.predict(x);
    const acq = mean + kappa * std;
    if (acq > bestAcq) { bestAcq = acq; bestX = x; }
  }
  return bestX;
}

mkdirSync("results_v14", { recursive: true });
console.log(`\nV14 Phantom-Fixed (GP-UCB) — Budget ${BUDGET}  3D  ${apiKey.slice(0, 8)}...`);
console.log(`  Objective: max score WITH all wallets < 3000ms. Hard gate x0.05 if >=3s.`);
console.log(`  Fix: phantom paginationToken skip (data.length < limit → no follow-through)`);
console.log(`  Search: window [60,160]  concurrency [8,48]  skip {0,1}`);

const gp = new GP(), Xs = [], ys = [], logs = [];
let bestAllUnder2 = null, bestAllUnder3 = null;

for (let trial = 0; trial < BUDGET; trial++) {
  const kappa    = 2.0 * Math.pow(0.92, trial);
  const x        = trial < 8 ? randomX() : suggest(gp, kappa);
  const strategy = xToStrategy(x);

  console.log(`\n[V14 trial ${trial + 1}/${BUDGET}  k=${kappa.toFixed(2)}]`);
  console.log(`  window=${strategy.windowSize}  c=${strategy.maxConcurrency}  skip=${strategy.skipZeroDelta}`);

  let score = 0;
  try {
    const result = await evaluate(strategy, apiKey);
    score = result.aggregate.score;
    const pw    = result.results.map(r => `${r.type[0]}:${r.wallMs.toFixed(0)}ms`).join("  ");
    const gstr  = result.aggregate.gate === 1.0 ? "ALL<2s" : result.aggregate.gate === 0.60 ? "some<3s" : "OVER3s";
    console.log(`  -> score=${score.toFixed(4)}  gate=${gstr}  maxMs=${result.aggregate.maxWalletMs.toFixed(0)}  avg=${result.aggregate.avgLatencyMs.toFixed(0)}  rpc=${result.aggregate.totalRpc}  [${pw}]`);
    logs.push({ trial: trial + 1, x, strategy, score, aggregate: result.aggregate, results: result.results });
    if (result.aggregate.gate === 1.0 && (!bestAllUnder2 || score > bestAllUnder2.score))
      bestAllUnder2 = { trial: trial + 1, score, strategy, aggregate: result.aggregate, results: result.results };
    if (result.aggregate.gate >= 0.60 && (!bestAllUnder3 || score > bestAllUnder3.score))
      bestAllUnder3 = { trial: trial + 1, score, strategy, aggregate: result.aggregate, results: result.results };
  } catch (err) {
    console.log(`  -> ERROR: ${err.message}`);
    logs.push({ trial: trial + 1, x, strategy, score: 0, error: err.message });
  }

  Xs.push(x); ys.push(score);
  if (Xs.length >= 2) gp.fit(Xs, ys);
  writeFileSync("results_v14/log.json", JSON.stringify(logs, null, 2));
}

const best = logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score)[0];
console.log(`\n${"=".repeat(60)}\nV14 PHANTOM-FIXED COMPLETE\n${"=".repeat(60)}`);

if (bestAllUnder2) {
  console.log(`\nBEST all-wallets-under-2s (gate=1.0, trial ${bestAllUnder2.trial}):`);
  console.log(`  Strategy:`, JSON.stringify(bestAllUnder2.strategy));
  console.log(`  Score: ${bestAllUnder2.score.toFixed(4)}  avgMs: ${bestAllUnder2.aggregate.avgLatencyMs.toFixed(0)}  maxMs: ${bestAllUnder2.aggregate.maxWalletMs.toFixed(0)}`);
  bestAllUnder2.results.forEach(r => console.log(`  ${r.type}: ${r.wallMs.toFixed(0)}ms ${r.rpcCalls} calls`));
} else {
  console.log(`\nNo trial achieved ALL wallets < 2s (gate=1.0).`);
}

if (bestAllUnder3 && bestAllUnder3 !== bestAllUnder2) {
  console.log(`\nBEST all-wallets-under-3s (gate=0.60+, trial ${bestAllUnder3.trial}):`);
  console.log(`  Strategy:`, JSON.stringify(bestAllUnder3.strategy));
  console.log(`  Score: ${bestAllUnder3.score.toFixed(4)}  avgMs: ${bestAllUnder3.aggregate.avgLatencyMs.toFixed(0)}  maxMs: ${bestAllUnder3.aggregate.maxWalletMs.toFixed(0)}`);
}

console.log(`\nBest overall (trial ${best?.trial}):`);
console.log(`  Strategy:`, JSON.stringify(best?.strategy));
console.log(`  Score: ${best?.score?.toFixed(4)}  avgMs: ${best?.aggregate?.avgLatencyMs?.toFixed(0)}  maxMs: ${best?.aggregate?.maxWalletMs?.toFixed(0)}`);
if (best?.results) best.results.forEach(r => console.log(`  ${r.type}: ${r.wallMs.toFixed(0)}ms ${r.rpcCalls} calls`));

const winner = bestAllUnder2 ?? bestAllUnder3 ?? best;
writeFileSync("results_v14/best_strategy.json", JSON.stringify({
  _meta: {
    method: "bayesian-gp-ucb-v14-phantom-fixed",
    best_all_under_2s: bestAllUnder2 ? { trial: bestAllUnder2.trial, score: bestAllUnder2.score } : null,
    best_all_under_3s: bestAllUnder3 ? { trial: bestAllUnder3.trial, score: bestAllUnder3.score } : null,
    best_overall:      best ? { trial: best.trial, score: best.score } : null,
  },
  ...winner?.strategy,
}, null, 2));

console.log("\nTop 5 (gate=1.0 first, then gate=0.60, then by score):");
const ranked = [
  ...logs.filter(l => l.aggregate?.gate === 1.0).sort((a, b) => b.score - a.score),
  ...logs.filter(l => l.aggregate?.gate === 0.60).sort((a, b) => b.score - a.score),
  ...logs.filter(l => l.aggregate?.gate < 0.60 && l.score > 0).sort((a, b) => b.score - a.score),
].slice(0, 5);
for (const r of ranked)
  console.log(`  #${r.trial}  score=${r.score.toFixed(4)}  gate=${r.aggregate?.gate?.toFixed(2)}  w=${r.strategy.windowSize}  c=${r.strategy.maxConcurrency}  skip=${r.strategy.skipZeroDelta}  max=${r.aggregate?.maxWalletMs?.toFixed(0)}ms  avg=${r.aggregate?.avgLatencyMs?.toFixed(0)}ms`);
