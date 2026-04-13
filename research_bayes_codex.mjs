/**
 * Bayesian Optimisation (GP-UCB) for Codex blockTime-density algorithm.
 *
 * Parameter space:
 *   x[0] windowTarget   [40, 95]
 *   x[1] maxConcurrency [4,  32]
 *
 * Usage:
 *   node research_bayes_codex.mjs <api-key> [budget=28]
 */

import { mkdirSync, writeFileSync } from "fs";
import { evaluate } from "./eval_codex.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const BUDGET = parseInt(process.argv[3] ?? "28", 10);

if (!apiKey) {
  console.error("Usage: node research_bayes_codex.mjs <api-key> [budget=28]");
  process.exit(1);
}

const PARAMS = [
  { name: "windowTarget", lo: 40, hi: 95, integer: true },
  { name: "maxConcurrency", lo: 4, hi: 32, integer: true },
];
const DIM = PARAMS.length;

function randomX() {
  return PARAMS.map(() => Math.random());
}

function xToStrategy(x) {
  const s = {};
  for (let i = 0; i < DIM; i++) {
    const p = PARAMS[i];
    const v = p.lo + x[i] * (p.hi - p.lo);
    s[p.name] = Math.round(v);
  }
  return s;
}

function rbfKernel(a, b, ls, sv) {
  let sq = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] - b[i]) / ls[i];
    sq += d * d;
  }
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
  const n = b.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let j = 0; j < i; j++) s -= L[i][j] * y[j];
    y[i] = s / L[i][i];
  }
  return y;
}

function solveLT(L, y) {
  const n = y.length;
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let j = i + 1; j < n; j++) s -= L[j][i] * x[j];
    x[i] = s / L[i][i];
  }
  return x;
}

class GP {
  constructor() {
    this.Xs = [];
    this.ys = [];
    this.yMean = 0;
    this.yStd = 1;
    this.ls = new Float64Array(DIM).fill(0.5);
    this.sv = 1.0;
    this.nv = 0.01;
  }

  fit(Xs, ys) {
    this.Xs = Xs;
    this.yMean = ys.reduce((s, y) => s + y, 0) / ys.length;
    const variance = ys.reduce((s, y) => s + (y - this.yMean) ** 2, 0) / ys.length;
    this.yStd = Math.sqrt(variance) || 1;
    this.ys = ys.map(y => (y - this.yMean) / this.yStd);

    const n = this.Xs.length;
    const K = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) =>
        rbfKernel(this.Xs[i], this.Xs[j], this.ls, this.sv) + (i === j ? this.nv : 0)
      )
    );
    this.L = cholesky(K);
    this.alpha = solveLT(this.L, solveL(this.L, this.ys));
  }

  predict(x) {
    if (this.Xs.length === 0) return { mean: 0, std: 1 };
    const ks = this.Xs.map(xi => rbfKernel(xi, x, this.ls, this.sv));
    const mean = ks.reduce((s, k, i) => s + k * this.alpha[i], 0);
    const v = solveL(this.L, ks);
    const variance = Math.max(0, rbfKernel(x, x, this.ls, this.sv) - v.reduce((s, vi) => s + vi * vi, 0));
    return { mean: mean * this.yStd + this.yMean, std: Math.sqrt(variance) * this.yStd };
  }
}

function suggest(gp, kappa) {
  let bestX = null;
  let bestAcq = -Infinity;
  for (let i = 0; i < 250; i++) {
    const x = randomX();
    const pred = gp.predict(x);
    const acq = pred.mean + kappa * pred.std;
    if (acq > bestAcq) {
      bestAcq = acq;
      bestX = x;
    }
  }
  return bestX;
}

mkdirSync("results_bayes_codex", { recursive: true });

console.log(`\n🔬 Bayesian Optimisation — Codex blockTime variant`);
console.log(`   Budget: ${BUDGET} | Params: windowTarget,maxConcurrency | API key: ${apiKey.slice(0, 8)}...`);

const gp = new GP();
const Xs = [];
const ys = [];
const logs = [];

for (let trial = 0; trial < BUDGET; trial++) {
  const kappa = 2.0 * Math.pow(0.9, trial);
  const x = trial < 5 ? randomX() : suggest(gp, kappa);
  const strategy = xToStrategy(x);

  console.log(`\n[BO-Codex ${trial + 1}/${BUDGET} κ=${kappa.toFixed(2)}] wTarget=${strategy.windowTarget} c=${strategy.maxConcurrency}`);

  let row;
  try {
    const result = await evaluate(strategy, apiKey);
    row = {
      trial: trial + 1,
      method: "bayesian-gp-ucb-codex",
      x,
      strategy,
      score: result.aggregate.score,
      aggregate: result.aggregate,
      results: result.results,
    };
    console.log(`  → score=${row.score.toFixed(4)} avgMs=${row.aggregate.avgLatencyMs.toFixed(0)} rpc=${row.aggregate.totalRpc}`);
  } catch (err) {
    row = {
      trial: trial + 1,
      method: "bayesian-gp-ucb-codex",
      x,
      strategy,
      score: 0,
      error: err.message,
    };
    console.log(`  → ERROR: ${err.message}`);
  }

  logs.push(row);
  Xs.push(x);
  ys.push(row.score);
  if (Xs.length >= 2) gp.fit(Xs, ys);
  writeFileSync("results_bayes_codex/log.json", JSON.stringify(logs, null, 2));
}

const best = logs.filter(x => x.score > 0).sort((a, b) => b.score - a.score)[0];
if (best) {
  writeFileSync(
    "results_bayes_codex/best_strategy.json",
    JSON.stringify(
      {
        _meta: {
          method: "bayesian-gp-ucb-codex",
          trial: best.trial,
          score: best.score,
          avgMs: best.aggregate?.avgLatencyMs,
        },
        ...best.strategy,
      },
      null,
      2
    )
  );
}

console.log(`\n${"═".repeat(60)}`);
console.log("BO CODEX COMPLETE");
console.log(`${"═".repeat(60)}`);
if (best) {
  console.log(`Best trial ${best.trial}: score=${best.score.toFixed(4)} avgMs=${best.aggregate?.avgLatencyMs?.toFixed(0)}`);
  console.log(JSON.stringify(best.strategy, null, 2));
}
