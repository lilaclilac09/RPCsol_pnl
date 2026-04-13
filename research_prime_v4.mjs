/**
 * PRIME optimiser for V4:
 * 1) broad random exploration
 * 2) GP-UCB guided search
 * 3) elite re-evaluation for stability
 * 4) local refinement around best stable candidate
 *
 * Usage:
 *   node research_prime_v4.mjs <api-key> [budget=54]
 */

import { mkdirSync, writeFileSync } from "fs";
import { evaluate } from "./eval_v4.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const BUDGET = parseInt(process.argv[3] ?? "54", 10);

if (!apiKey) {
  console.error("Usage: node research_prime_v4.mjs <api-key> [budget=54]");
  process.exit(1);
}

const PARAMS = [
  { name: "anchorSize", lo: 10, hi: 100, integer: true },
  { name: "windowTarget", lo: 20, hi: 100, integer: true },
  { name: "maxConcurrency", lo: 4, hi: 32, integer: true },
  { name: "skipZeroDelta", lo: 0, hi: 1, boolean: true },
];

const DIM = PARAMS.length;
const FIXED = { sigPageSize: 1000, windowSize: 80 };

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
  s.windowSize = s.windowTarget;
  return s;
}

function strategyToX(s) {
  return PARAMS.map(p => {
    if (p.boolean) return s[p.name] ? 1 : 0;
    return (s[p.name] - p.lo) / (p.hi - p.lo);
  });
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
    if (!this.Xs.length) return { mean: 0, std: 1 };
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
    const p = gp.predict(x);
    const acq = p.mean + kappa * p.std;
    if (acq > bestAcq) {
      bestAcq = acq;
      bestX = x;
    }
  }
  return bestX;
}

function perturb(baseX, radius) {
  return baseX.map((v, i) => {
    const jitter = (Math.random() * 2 - 1) * radius;
    const x = clamp(v + jitter, 0, 1);
    if (PARAMS[i].boolean) return x > 0.5 ? 1 : 0;
    return x;
  });
}

async function runEval(strategy) {
  const res = await evaluate(strategy, apiKey);
  return {
    score: res.aggregate.score,
    aggregate: res.aggregate,
    results: res.results,
  };
}

mkdirSync("results_prime_v4", { recursive: true });

console.log("\nPRIME V4 optimiser");
console.log(`Budget: ${BUDGET}, API: ${apiKey.slice(0, 8)}...`);

const logs = [];
const Xs = [];
const ys = [];
const gp = new GP();

const explore = Math.max(12, Math.floor(BUDGET * 0.25));
const guided = Math.max(20, Math.floor(BUDGET * 0.55));
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
  if (logs.length % 2 === 0) writeFileSync("results_prime_v4/log.json", JSON.stringify(logs, null, 2));
}

// Stage 1: broad exploration
for (let i = 0; i < explore && used < BUDGET; i++) {
  await evaluateOne(randomX(), "explore");
}

// Stage 2: GP-UCB guided search
for (let i = 0; i < guided && used < BUDGET; i++) {
  const kappa = 2.0 * Math.pow(0.93, i);
  await evaluateOne(suggest(gp, kappa), "guided");
}

// Stage 3: elite reevaluation and local refinement
const elites = logs
  .slice()
  .sort((a, b) => b.score - a.score)
  .slice(0, 4);

const stable = [];
for (const e of elites) {
  if (used >= BUDGET) break;
  const repeatScores = [e.score];
  const repeats = Math.min(2, BUDGET - used);
  for (let r = 0; r < repeats; r++) {
    const out = await runEval(e.strategy);
    repeatScores.push(out.score);
    used++;
    console.log(`[elite-repeat] base#${e.idx} repeat score=${out.score.toFixed(4)}`);
  }
  const mean = repeatScores.reduce((s, v) => s + v, 0) / repeatScores.length;
  stable.push({ base: e, meanScore: mean });
}

stable.sort((a, b) => b.meanScore - a.meanScore);
const bestStable = stable[0]?.base;

if (bestStable) {
  let radius = 0.08;
  while (used < BUDGET && radius >= 0.02) {
    const tries = Math.min(4, BUDGET - used);
    for (let i = 0; i < tries && used < BUDGET; i++) {
      const x = perturb(bestStable.x, radius);
      await evaluateOne(x, "refine");
    }
    radius *= 0.7;
  }
}

writeFileSync("results_prime_v4/log.json", JSON.stringify(logs, null, 2));

const best = logs.slice().sort((a, b) => b.score - a.score)[0];

// stable ranking over top candidates (mean of up to 3 existing observations in logs)
const byKey = new Map();
for (const row of logs) {
  const k = JSON.stringify(row.strategy);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(row.score);
}
const stableRank = [];
for (const [k, arr] of byKey.entries()) {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  stableRank.push({ strategy: JSON.parse(k), meanScore: mean, n: arr.length });
}
stableRank.sort((a, b) => b.meanScore - a.meanScore);

writeFileSync(
  "results_prime_v4/best_strategy.json",
  JSON.stringify(
    {
      _meta: {
        method: "prime-v4",
        budget: BUDGET,
        bestTrialScore: best?.score,
        stableTopMean: stableRank[0]?.meanScore,
        stableN: stableRank[0]?.n,
      },
      ...(stableRank[0]?.strategy ?? best?.strategy ?? {}),
    },
    null,
    2
  )
);

console.log("\n============================================================");
console.log("PRIME V4 COMPLETE");
console.log("============================================================");
if (best) {
  console.log(`Peak score=${best.score.toFixed(4)} strategy=${JSON.stringify(best.strategy)}`);
}
if (stableRank[0]) {
  console.log(`Stable top mean=${stableRank[0].meanScore.toFixed(4)} n=${stableRank[0].n}`);
  console.log(JSON.stringify(stableRank[0].strategy, null, 2));
}
