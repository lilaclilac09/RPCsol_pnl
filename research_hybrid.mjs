/**
 * Hybrid Density-Router — Bayesian GP-UCB (free-tier, 3-run median eval)
 *
 * Optimises the 5 per-type parameters in sol_balance_hybrid.mjs:
 *   sparseThreshold  [3, 25]   boundary between "sparse" and "medium" classification
 *   txTargetSparse   [3, 15]   fetch target for sparse wallets
 *   cSparse          [4, 12]   concurrency for sparse wallets
 *   txTargetMedDense [20, 60]  fetch target for medium/dense wallets
 *   cMedDense        [8, 24]   concurrency for medium/dense wallets
 *
 * Fixed: sigPageSize=1000, maxSigPages=6, skipZeroDelta=false (BO-found best in V15)
 *
 * Key insight vs V15 monolithic:
 *   Sparse wallets have ~4 sigs — a lower txTargetSparse + smaller semaphore
 *   reduces unnecessary fetching and avoids consuming concurrency slots that
 *   medium/dense wallets need. Classification is zero-cost (uses Phase 0 page).
 *
 * Usage: node research_hybrid.mjs <api-key> [budget=60]
 */
import { mkdirSync, writeFileSync } from "fs";
import { solBalanceFreeTierOnly }   from "./sol_balance_hybrid.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const BUDGET = parseInt(process.argv[3] ?? "60", 10);
if (!apiKey) { console.error("Usage: node research_hybrid.mjs <api-key> [budget=60]"); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// 3-run median evaluator (inline — no extra import)
// ─────────────────────────────────────────────────────────────────────────────

const TEST_WALLETS = [
  { address: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs", type: "sparse",  expectedMinSamples: 4   },
  { address: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs", type: "medium",  expectedMinSamples: 30  },
  { address: "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n", type: "dense",   expectedMinSamples: 100 },
];
const RUNS = 3;

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function evaluate(strategy) {
  const results = [];
  for (const wallet of TEST_WALLETS) {
    const wallMsArr = [], rpcArr = [], sampleArr = [], gapArr = [];
    let anyComplete = false;
    for (let r = 0; r < RUNS; r++) {
      try {
        const t0     = performance.now();
        const result = await solBalanceFreeTierOnly(wallet.address, apiKey, strategy);
        const wallMs = performance.now() - t0;
        wallMsArr.push(wallMs);
        rpcArr.push(result.stats.totalRpcCalls);
        sampleArr.push(result.stats.sampleCount);
        gapArr.push(result.stats.openGapsRemaining);
        if (result.stats.sampleCount >= wallet.expectedMinSamples) anyComplete = true;
      } catch {
        wallMsArr.push(120000); rpcArr.push(999); sampleArr.push(0); gapArr.push(99);
      }
    }
    results.push({
      wallet: wallet.address, type: wallet.type,
      wallMs:     median(wallMsArr),
      wallMsMin:  Math.min(...wallMsArr),
      wallMsMax:  Math.max(...wallMsArr),
      rpcCalls:   Math.round(median(rpcArr)),
      sampleCount: Math.round(median(sampleArr)),
      openGaps:   Math.round(median(gapArr)),
      complete:   anyComplete,
    });
  }

  const avgLatencyMs   = results.reduce((s, r) => s + r.wallMs,   0) / results.length;
  const maxWalletMs    = Math.max(...results.map(r => r.wallMs));
  const totalRpc       = results.reduce((s, r) => s + r.rpcCalls, 0);
  const openGapPenalty = results.reduce((s, r) => s + r.openGaps, 0);
  const completeness   = results.filter(r => r.complete).length / results.length;

  const gate = maxWalletMs >= 3000 ? 0.05
             : maxWalletMs >= 2000 ? 0.60
             : 1.0;

  const score = completeness > 0
    ? (completeness * 1000 / avgLatencyMs) * Math.max(0.1, 1 - 0.05 * openGapPenalty) * gate
    : 0;

  return { strategy, results,
           aggregate: { avgLatencyMs, maxWalletMs, totalRpc, openGapPenalty, completeness, score, gate } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bayesian GP-UCB
// ─────────────────────────────────────────────────────────────────────────────

const PARAMS = [
  { name: "sparseThreshold",  lo: 3,  hi: 25, integer: true },
  { name: "txTargetSparse",   lo: 3,  hi: 15, integer: true },
  { name: "cSparse",          lo: 4,  hi: 12, integer: true },
  { name: "txTargetMedDense", lo: 20, hi: 60, integer: true },
  { name: "cMedDense",        lo: 8,  hi: 24, integer: true },
];
const DIM   = PARAMS.length;
const FIXED = { sigPageSize: 1000, maxSigPages: 6, skipZeroDelta: false };

function xToStrategy(x) {
  const s = { ...FIXED };
  for (let i = 0; i < DIM; i++) {
    const p = PARAMS[i];
    s[p.name] = Math.round(x[i] * (p.hi - p.lo) + p.lo);
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
  constructor() { this.ls = new Float64Array(DIM).fill(0.35); this.sv = 1.0; this.nv = 0.02; this.Xs = []; this.ys = []; this.yMean = 0; this.yStd = 1; }
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
  for (let i = 0; i < 1500; i++) {
    const x = randomX();
    const { mean, std } = gp.predict(x);
    const acq = mean + kappa * std;
    if (acq > bestAcq) { bestAcq = acq; bestX = x; }
  }
  return bestX;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────

mkdirSync("results_hybrid", { recursive: true });
console.log(`\nHybrid GP-UCB (3-run median) — Budget ${BUDGET}  5D  ${apiKey.slice(0, 8)}...`);
console.log(`  Solver: free-tier density-aware router`);
console.log(`  Search: sparseThreshold [3,25]  txTargetSparse [3,15]  cSparse [4,12]  txTargetMedDense [20,60]  cMedDense [8,24]`);

const gp = new GP(), Xs = [], ys = [], logs = [];
let bestGate1 = null, bestOverall = null;

for (let trial = 0; trial < BUDGET; trial++) {
  const kappa    = 2.0 * Math.pow(0.93, trial);
  const x        = trial < 12 ? randomX() : suggest(gp, kappa);
  const strategy = xToStrategy(x);

  console.log(`\n[Hybrid trial ${trial + 1}/${BUDGET}  k=${kappa.toFixed(2)}]`);
  console.log(`  sparseThresh=${strategy.sparseThreshold}  txSparse=${strategy.txTargetSparse}  cSparse=${strategy.cSparse}  txMedDense=${strategy.txTargetMedDense}  cMedDense=${strategy.cMedDense}`);

  let score = 0;
  try {
    const result = await evaluate(strategy);
    score = result.aggregate.score;
    const pw   = result.results.map(r =>
      `${r.type[0]}:${r.wallMs.toFixed(0)}ms(${r.detectedDensity ?? "?"})[${r.wallMsMin.toFixed(0)}-${r.wallMsMax.toFixed(0)}]/${r.rpcCalls}c`
    ).join("  ");
    const gstr = result.aggregate.gate === 1.0 ? "ALL<2s✓" : result.aggregate.gate === 0.60 ? "some<3s" : "OVER3s✗";
    console.log(`  -> score=${score.toFixed(4)}  gate=${gstr}  maxMs=${result.aggregate.maxWalletMs.toFixed(0)}  avg=${result.aggregate.avgLatencyMs.toFixed(0)}  rpc=${result.aggregate.totalRpc}`);
    console.log(`     [${pw}]`);

    // Fetch detected densities from final (last) run results
    const enrichedResults = result.results;
    logs.push({ trial: trial + 1, x, strategy, score,
                aggregate: result.aggregate, results: enrichedResults });
    if (result.aggregate.gate === 1.0 && (!bestGate1 || score > bestGate1.score))
      bestGate1 = { trial: trial + 1, score, strategy, aggregate: result.aggregate };
    if (!bestOverall || score > bestOverall.score)
      bestOverall = { trial: trial + 1, score, strategy, aggregate: result.aggregate };
  } catch (err) {
    console.log(`  -> ERROR: ${err.message}`);
    logs.push({ trial: trial + 1, x, strategy, score: 0, error: err.message });
  }

  Xs.push(x); ys.push(score);
  if (Xs.length >= 2) gp.fit(Xs, ys);
  writeFileSync("results_hybrid/log.json", JSON.stringify(logs, null, 2));

  // Save best strategy
  const best = logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score)[0];
  const winner = bestGate1?.strategy ?? best?.strategy ?? strategy;
  writeFileSync("results_hybrid/best_strategy.json", JSON.stringify({
    _meta: {
      method: "bayesian-gp-ucb-hybrid-5d-3run",
      solver: "free-tier density-aware router",
      runs_per_eval: RUNS,
      trials_complete: trial + 1,
      trials_total: BUDGET,
      status: trial + 1 < BUDGET ? "running" : "complete",
      best_gate1:   bestGate1  ? { trial: bestGate1.trial,  score: bestGate1.score,
                                    avgLatencyMs: bestGate1.aggregate.avgLatencyMs,
                                    maxWalletMs:  bestGate1.aggregate.maxWalletMs } : null,
      best_overall: bestOverall ? { trial: bestOverall.trial, score: bestOverall.score,
                                    gate: bestOverall.aggregate.gate,
                                    avgLatencyMs: bestOverall.aggregate.avgLatencyMs,
                                    maxWalletMs:  bestOverall.aggregate.maxWalletMs } : null,
    },
    ...winner,
  }, null, 2));
}

const best = logs.filter(l => l.score > 0).sort((a, b) => b.score - a.score)[0];
console.log(`\n${"=".repeat(60)}\nHYBRID BO COMPLETE\n${"=".repeat(60)}`);

if (bestGate1) {
  console.log(`\nBEST gate=1.0 (trial ${bestGate1.trial}): score=${bestGate1.score.toFixed(4)}`);
  console.log(`  Strategy:`, JSON.stringify(bestGate1.strategy));
}
console.log(`\nBest overall (trial ${best?.trial}): score=${best?.score?.toFixed(4)}`);
console.log(`  Strategy:`, JSON.stringify(best?.strategy));

console.log("\nTop 5 (gate=1.0 first, then by score):");
const ranked = [
  ...logs.filter(l => l.aggregate?.gate === 1.0).sort((a, b) => b.score - a.score),
  ...logs.filter(l => l.aggregate?.gate !== 1.0 && l.score > 0).sort((a, b) => b.score - a.score),
].slice(0, 5);
for (const r of ranked)
  console.log(`  #${r.trial}  score=${r.score.toFixed(4)}  gate=${r.aggregate?.gate?.toFixed(2)}  spThresh=${r.strategy.sparseThreshold}  txS=${r.strategy.txTargetSparse}  cS=${r.strategy.cSparse}  txM=${r.strategy.txTargetMedDense}  cM=${r.strategy.cMedDense}  max=${r.aggregate?.maxWalletMs?.toFixed(0)}ms`);
