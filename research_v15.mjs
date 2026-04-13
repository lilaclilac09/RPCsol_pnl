/**
 * V15 Stable — Bayesian GP-UCB (free-tier, 3-run median eval)
 *
 * Solver: getSignaturesForAddress + parallel getTransaction (free Helius tier).
 * Eval:   3 runs per trial, median wall time per wallet (removes lucky outliers).
 * Obj:    max score; gate ×0.05 if any wallet ≥3s, ×0.60 if ≥2s.
 *
 * Free-tier key insight: gate penalty dominates. At 10 RPS free-tier limit:
 *   txTarget=120 → gate=0.05 → score ~0.005 even at full completeness
 *   txTarget=20  → gate=1.0  → score ~0.18 at sparse-only completeness (36x better!)
 * BO must explore low txTarget region to discover this tradeoff.
 *
 * Search space:
 *   txTarget       [5, 60]    low end keeps wallets under 2s; high end for completeness
 *   maxConcurrency [4, 24]    parallelism vs rate-limit tradeoff
 *   skipZeroDelta  {0, 1}     filter zero-delta txns after fetch
 *
 * Usage: node research_v15.mjs <api-key> [budget=50]
 */
import { mkdirSync, writeFileSync } from "fs";
import { evaluate } from "./eval_v15_stable.mjs";
import { probeCapabilities } from "./capability_probe.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const BUDGET = parseInt(process.argv[3] ?? "50", 10);
if (!apiKey) { console.error("Usage: node research_v15.mjs <api-key> [budget=50]"); process.exit(1); }

const PARAMS = [
  { name: "denseTarget",    lo: 80,  hi: 180, integer: true  },
  { name: "mediumTarget",   lo: 24,  hi: 72,  integer: true  },
  { name: "maxConcurrency", lo: 4,   hi: 20,  integer: true  },
  { name: "minRequestIntervalMs", lo: 70, hi: 200, integer: true },
  { name: "skipZeroDelta",  lo: 0,   hi: 1,   boolean: true  },
];
const DIM   = PARAMS.length;
const FIXED = { sigPageSize: 1000, maxSigPages: 6, phase1Coverage: 36 };

function xToStrategy(x) {
  const s = { ...FIXED };
  for (let i = 0; i < DIM; i++) {
    const p = PARAMS[i];
    const v = x[i] * (p.hi - p.lo) + p.lo;
    s[p.name] = p.boolean ? v > 0.5 : Math.round(v);
  }
  s.walletBudgets = {
    sparse: 8,
    medium: s.mediumTarget,
    dense: s.denseTarget,
  };
  s.txTarget = s.denseTarget;
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
  constructor() { this.ls = new Float64Array(DIM).fill(0.4); this.sv = 1.0; this.nv = 0.02; this.Xs = []; this.ys = []; this.yMean = 0; this.yStd = 1; }
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
  for (let i = 0; i < 1000; i++) {
    const x = randomX();
    const { mean, std } = gp.predict(x);
    const acq = mean + kappa * std;
    if (acq > bestAcq) { bestAcq = acq; bestX = x; }
  }
  return bestX;
}

mkdirSync("results_v15", { recursive: true });
const capability = await probeCapabilities(apiKey);
console.log(`\nV15 Stable GP-UCB (3-run median) — Budget ${BUDGET}  5D  ${apiKey.slice(0, 8)}...`);
console.log(`  Solver: free-tier (getSignaturesForAddress + getTransaction)`);
console.log(`  Key mode: ${capability.mode}  (batch=${capability.batchAllowed ? "yes" : "no"}, gta=${capability.paidCapable ? "yes" : "no"})`);
console.log(`  Search: denseTarget [80,180] mediumTarget [24,72] concurrency [4,20] minInterval [70,200] skip {0,1}`);

const gp = new GP(), Xs = [], ys = [], logs = [];
let bestGate1 = null, bestOverall = null;

for (let trial = 0; trial < BUDGET; trial++) {
  const kappa    = 2.0 * Math.pow(0.93, trial);
  const x        = trial < 9 ? randomX() : suggest(gp, kappa);
  const strategy = xToStrategy(x);

  console.log(`\n[V15 trial ${trial + 1}/${BUDGET}  k=${kappa.toFixed(2)}]`);
  console.log(`  dense=${strategy.walletBudgets.dense} medium=${strategy.walletBudgets.medium} c=${strategy.maxConcurrency} interval=${strategy.minRequestIntervalMs} skip=${strategy.skipZeroDelta}`);

  let score = 0;
  try {
    const result = await evaluate(strategy, apiKey);
    score = result.aggregate.score;
    const pw   = result.results.map(r =>
      `${r.type[0]}:${r.wallMs.toFixed(0)}ms[${r.wallMsMin?.toFixed(0)}-${r.wallMsMax?.toFixed(0)}]/${r.rpcCalls}c`
    ).join("  ");
    const gstr = result.aggregate.gate === 1.0 ? "ALL<2s✓" : result.aggregate.gate === 0.60 ? "some<3s" : "OVER3s✗";
    console.log(`  -> score=${score.toFixed(4)}  gate=${gstr}  maxMs=${result.aggregate.maxWalletMs.toFixed(0)}  avg=${result.aggregate.avgLatencyMs.toFixed(0)}  rpc=${result.aggregate.totalRpc}`);
    console.log(`     [${pw}]`);
    logs.push({ trial: trial + 1, x, strategy, score, runs: result.runs, aggregate: result.aggregate, results: result.results });
    if (result.aggregate.gate === 1.0 && (!bestGate1 || score > bestGate1.score))
      bestGate1 = { trial: trial + 1, score, strategy, aggregate: result.aggregate, results: result.results };
    if (!bestOverall || score > bestOverall.score)
      bestOverall = { trial: trial + 1, score, strategy, aggregate: result.aggregate, results: result.results };
  } catch (err) {
    console.log(`  -> ERROR: ${err.message}`);
    logs.push({ trial: trial + 1, x, strategy, score: 0, error: err.message });
  }

  Xs.push(x); ys.push(score);
  if (Xs.length >= 2) gp.fit(Xs, ys);
  writeFileSync("results_v15/log.json", JSON.stringify(logs, null, 2));
}

const best = logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score)[0];
console.log(`\n${"=".repeat(60)}\nV15 STABLE COMPLETE\n${"=".repeat(60)}`);

if (bestGate1) {
  console.log(`\nBEST all-wallets-under-2s (gate=1.0, trial ${bestGate1.trial}):`);
  console.log(`  Strategy:`, JSON.stringify(bestGate1.strategy));
  console.log(`  Score: ${bestGate1.score.toFixed(4)}  avg: ${bestGate1.aggregate.avgLatencyMs.toFixed(0)}ms  max: ${bestGate1.aggregate.maxWalletMs.toFixed(0)}ms`);
  bestGate1.results.forEach(r =>
    console.log(`  ${r.type}: med=${r.wallMs.toFixed(0)}ms [${r.wallMsMin?.toFixed(0)}–${r.wallMsMax?.toFixed(0)}]  ${r.rpcCalls} calls  ${r.sampleCount} samples`));
}

console.log(`\nBest overall (trial ${best?.trial}):`);
console.log(`  Strategy:`, JSON.stringify(best?.strategy));
console.log(`  Score: ${best?.score?.toFixed(4)}  avg: ${best?.aggregate?.avgLatencyMs?.toFixed(0)}ms  max: ${best?.aggregate?.maxWalletMs?.toFixed(0)}ms`);
if (best?.results) best.results.forEach(r =>
  console.log(`  ${r.type}: med=${r.wallMs.toFixed(0)}ms [${r.wallMsMin?.toFixed(0)}–${r.wallMsMax?.toFixed(0)}]  ${r.rpcCalls} calls  ${r.sampleCount} samples`));

const winner = bestGate1 ?? best;
writeFileSync("results_v15/best_strategy.json", JSON.stringify({
  _meta: {
    method: "bayesian-gp-ucb-v15-stable-3run",
    solver: "free-tier (getSignaturesForAddress + getTransaction)",
    capability,
    runs_per_eval: 3,
    best_gate1:   bestGate1 ? { trial: bestGate1.trial, score: bestGate1.score } : null,
    best_overall: best      ? { trial: best.trial,      score: best.score      } : null,
  },
  ...winner?.strategy,
}, null, 2));

console.log("\nTop 5 (gate=1.0 first, then by score):");
const ranked = [
  ...logs.filter(l => l.aggregate?.gate === 1.0).sort((a, b) => b.score - a.score),
  ...logs.filter(l => l.aggregate?.gate !== 1.0 && l.score > 0).sort((a, b) => b.score - a.score),
].slice(0, 5);
for (const r of ranked)
  console.log(`  #${r.trial}  score=${r.score.toFixed(4)}  gate=${r.aggregate?.gate?.toFixed(2)}  dense=${r.strategy.walletBudgets?.dense} medium=${r.strategy.walletBudgets?.medium} c=${r.strategy.maxConcurrency} interval=${r.strategy.minRequestIntervalMs} skip=${r.strategy.skipZeroDelta}  max=${r.aggregate?.maxWalletMs?.toFixed(0)}ms  avg=${r.aggregate?.avgLatencyMs?.toFixed(0)}ms`);
