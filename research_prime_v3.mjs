/**
 * PRIME optimiser for V3:
 * random exploration + GP-UCB + local refinement.
 *
 * Usage:
 *   node research_prime_v3.mjs <api-key> [budget=56]
 */

import { mkdirSync, writeFileSync } from "fs";
import { evaluate } from "./eval_v3.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const BUDGET = parseInt(process.argv[3] ?? "56", 10);

if (!apiKey) {
  console.error("Usage: node research_prime_v3.mjs <api-key> [budget=56]");
  process.exit(1);
}

const PARAMS = [
  { name: "anchorSize", lo: 10, hi: 100, integer: true },
  { name: "windowSize", lo: 20, hi: 100, integer: true },
  { name: "maxConcurrency", lo: 4, hi: 32, integer: true },
  { name: "skipZeroDelta", lo: 0, hi: 1, boolean: true },
];

const DIM = PARAMS.length;
const FIXED = { sigPageSize: 1000, maxSigPages: 20 };

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function randomX() {
  return PARAMS.map(() => Math.random());
}

function xToStrategy(x) {
  const s = { ...FIXED };
  for (let i = 0; i < DIM; i++) {
    const p = PARAMS[i];
    const v = p.lo + x[i] * (p.hi - p.lo);
    s[p.name] = p.boolean ? v > 0.5 : Math.round(v);
  }
  return s;
}

function rbf(a, b, ls, sv) {
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

    const n = Xs.length;
    const K = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => rbf(Xs[i], Xs[j], this.ls, this.sv) + (i === j ? this.nv : 0))
    );
    this.L = cholesky(K);
    this.alpha = solveLT(this.L, solveL(this.L, this.ys));
  }

  predict(x) {
    if (this.Xs.length === 0) return { mean: 0, std: 1 };
    const ks = this.Xs.map(xi => rbf(xi, x, this.ls, this.sv));
    const mean = ks.reduce((s, k, i) => s + k * this.alpha[i], 0);
    const v = solveL(this.L, ks);
    const variance = Math.max(0, rbf(x, x, this.ls, this.sv) - v.reduce((s, vi) => s + vi * vi, 0));
    return { mean: mean * this.yStd + this.yMean, std: Math.sqrt(variance) * this.yStd };
  }
}

function suggest(gp, kappa) {
  let bestX = null;
  let bestAcq = -Infinity;
  for (let i = 0; i < 300; i++) {
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

function perturb(x, radius) {
  return x.map((v, i) => {
    const p = PARAMS[i];
    const n = clamp(v + (Math.random() * 2 - 1) * radius, 0, 1);
    if (p.boolean) return n > 0.5 ? 1 : 0;
    return n;
  });
}

async function runEval(strategy) {
  const res = await evaluate(strategy, apiKey);
  return { score: res.aggregate.score, aggregate: res.aggregate, results: res.results };
}

mkdirSync("results_prime_v3", { recursive: true });
console.log("\nPRIME V3 optimiser");
console.log(`Budget: ${BUDGET}, API: ${apiKey.slice(0, 8)}...`);

const logs = [];
const Xs = [];
const ys = [];
const gp = new GP();

const explore = Math.max(12, Math.floor(BUDGET * 0.25));
let used = 0;

async function evaluateOne(x, phase) {
  const strategy = xToStrategy(x);
  const out = await runEval(strategy);
  const row = {
    idx: logs.length + 1,
    phase,
    x,
    strategy,
    score: out.score,
    aggregate: out.aggregate,
  };
  logs.push(row);
  Xs.push(x);
  ys.push(out.score);
  if (Xs.length >= 2) gp.fit(Xs, ys);
  used++;
  console.log(`[${phase}] #${row.idx} score=${row.score.toFixed(4)} avgMs=${row.aggregate.avgLatencyMs.toFixed(0)} rpc=${row.aggregate.totalRpc}`);
  if (logs.length % 2 === 0) writeFileSync("results_prime_v3/log.json", JSON.stringify(logs, null, 2));
}

for (let i = 0; i < explore && used < BUDGET; i++) await evaluateOne(randomX(), "explore");

let step = 0;
while (used < BUDGET - 6) {
  const kappa = 2.0 * Math.pow(0.94, step++);
  await evaluateOne(suggest(gp, kappa), "guided");
}

const top = logs.slice().sort((a, b) => b.score - a.score)[0];
if (top) {
  let radius = 0.09;
  while (used < BUDGET && radius >= 0.02) {
    const count = Math.min(3, BUDGET - used);
    for (let i = 0; i < count && used < BUDGET; i++) {
      await evaluateOne(perturb(top.x, radius), "refine");
    }
    radius *= 0.7;
  }
}

writeFileSync("results_prime_v3/log.json", JSON.stringify(logs, null, 2));
const best = logs.slice().sort((a, b) => b.score - a.score)[0];

writeFileSync(
  "results_prime_v3/best_strategy.json",
  JSON.stringify(
    {
      _meta: { method: "prime-v3", budget: BUDGET, bestTrialScore: best?.score },
      ...(best?.strategy ?? {}),
    },
    null,
    2
  )
);

console.log("\n============================================================");
console.log("PRIME V3 COMPLETE");
console.log("============================================================");
if (best) {
  console.log(`Peak score=${best.score.toFixed(4)} strategy=${JSON.stringify(best.strategy)}`);
}
