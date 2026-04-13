/**
 * TPE-style optimisation (Parzen estimator inspired, no external deps).
 *
 * Usage:
 *   node research_tpe.mjs <api-key> [trials=40]
 */

import { mkdirSync, writeFileSync } from "fs";
import { evaluate } from "./eval_v2.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const TRIALS = parseInt(process.argv[3] ?? "40", 10);

if (!apiKey) {
  console.error("Usage: node research_tpe.mjs <api-key> [trials=40]");
  process.exit(1);
}

const PARAMS = [
  { name: "anchorSize", lo: 10, hi: 100, type: "int" },
  { name: "windowSize", lo: 20, hi: 100, type: "int" },
  { name: "maxConcurrency", lo: 4, hi: 24, type: "int" },
  { name: "useContinuityOracle", lo: 0, hi: 1, type: "bool" },
  { name: "skipZeroDelta", lo: 0, hi: 1, type: "bool" },
];

const FIXED = { sigPageSize: 1000, maxSigPages: 20 };

function randomStrategy() {
  const s = { ...FIXED };
  for (const p of PARAMS) {
    if (p.type === "bool") s[p.name] = Math.random() > 0.5;
    else s[p.name] = Math.round(p.lo + Math.random() * (p.hi - p.lo));
  }
  return s;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function randn() {
  const u1 = 1 - Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleAround(base, spread = 0.15) {
  const s = { ...FIXED };
  for (const p of PARAMS) {
    if (p.type === "bool") {
      const cur = base[p.name] ? 1 : 0;
      const flipProb = Math.max(0.05, spread);
      const next = Math.random() < flipProb ? 1 - cur : cur;
      s[p.name] = Boolean(next);
      continue;
    }

    const range = p.hi - p.lo;
    const normalized = (base[p.name] - p.lo) / range;
    const v = clamp(normalized + randn() * spread, 0, 1);
    s[p.name] = Math.round(p.lo + v * range);
  }
  return s;
}

function weightedPick(items) {
  const total = items.reduce((sum, i) => sum + i.w, 0);
  let r = Math.random() * total;
  for (const i of items) {
    r -= i.w;
    if (r <= 0) return i;
  }
  return items[items.length - 1];
}

mkdirSync("results_tpe", { recursive: true });

const logs = [];
let best = null;
const warmup = Math.min(8, Math.max(5, Math.floor(TRIALS * 0.2)));

console.log(`\n🔬 TPE-style search`);
console.log(`   Trials: ${TRIALS} | warmup: ${warmup} | API key: ${apiKey.slice(0, 8)}...`);

for (let t = 1; t <= TRIALS; t++) {
  let strategy;

  if (t <= warmup || logs.length < 6) {
    strategy = randomStrategy();
  } else {
    const sorted = [...logs].filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    const goodCount = Math.max(3, Math.floor(sorted.length * 0.25));
    const good = sorted.slice(0, goodCount);
    const bad = sorted.slice(goodCount);

    const goodRef = weightedPick(good.map(g => ({ ...g, w: g.score + 1e-6 })));
    const badMean = bad.length > 0
      ? bad.reduce((s, x) => s + x.score, 0) / bad.length
      : 0;

    const spread = best && best.score > 0
      ? clamp(0.22 - (best.score - badMean), 0.05, 0.22)
      : 0.15;

    strategy = sampleAround(goodRef.strategy, spread);
  }

  console.log(`\n[TPE ${t}/${TRIALS}] anchor=${strategy.anchorSize} window=${strategy.windowSize} c=${strategy.maxConcurrency} oracle=${strategy.useContinuityOracle} skipZero=${strategy.skipZeroDelta}`);

  let entry;
  try {
    const result = await evaluate(strategy, apiKey);
    entry = {
      trial: t,
      method: "tpe",
      strategy,
      score: result.aggregate.score,
      aggregate: result.aggregate,
    };
    console.log(`  → score=${entry.score.toFixed(4)} avgMs=${entry.aggregate.avgLatencyMs.toFixed(0)} rpc=${entry.aggregate.totalRpc}`);
  } catch (err) {
    entry = {
      trial: t,
      method: "tpe",
      strategy,
      score: 0,
      error: err.message,
    };
    console.log(`  → ERROR: ${err.message}`);
  }

  logs.push(entry);
  if (!best || entry.score > best.score) {
    best = entry;
    console.log(`  ✅ new best ${best.score.toFixed(4)} at trial ${best.trial}`);
  }

  writeFileSync("results_tpe/log.json", JSON.stringify(logs, null, 2));
}

if (best) {
  writeFileSync(
    "results_tpe/best_strategy.json",
    JSON.stringify(
      {
        _meta: { method: "tpe", trial: best.trial, score: best.score },
        ...best.strategy,
      },
      null,
      2
    )
  );
}

console.log(`\n${"═".repeat(60)}`);
console.log("TPE SEARCH COMPLETE");
console.log(`${"═".repeat(60)}`);
if (best) {
  console.log(`Best: score=${best.score.toFixed(4)} trial=${best.trial}`);
  console.log(JSON.stringify(best.strategy, null, 2));
}
