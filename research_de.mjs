/**
 * Differential Evolution (DE/rand/1/bin) for V2 strategy optimisation.
 *
 * Usage:
 *   node research_de.mjs <api-key> [generations=8] [population=12]
 */

import { mkdirSync, writeFileSync } from "fs";
import { evaluate } from "./eval_v2.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const GENERATIONS = parseInt(process.argv[3] ?? "8", 10);
const POP_SIZE = parseInt(process.argv[4] ?? "12", 10);

if (!apiKey) {
  console.error("Usage: node research_de.mjs <api-key> [generations=8] [population=12]");
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
const DIM = PARAMS.length;
const F = 0.7;
const CR = 0.8;

function randBetween(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

function toVector(strategy) {
  return PARAMS.map(p => {
    if (p.type === "bool") return strategy[p.name] ? 1 : 0;
    return (strategy[p.name] - p.lo) / (p.hi - p.lo);
  });
}

function fromVector(v) {
  const s = { ...FIXED };
  PARAMS.forEach((p, i) => {
    const x = Math.max(0, Math.min(1, v[i]));
    if (p.type === "bool") s[p.name] = x > 0.5;
    else s[p.name] = Math.round(p.lo + x * (p.hi - p.lo));
  });
  return s;
}

function randomStrategy() {
  const s = { ...FIXED };
  for (const p of PARAMS) {
    if (p.type === "bool") s[p.name] = Math.random() > 0.5;
    else s[p.name] = Math.round(randBetween(p.lo, p.hi));
  }
  return s;
}

function pickDistinctIndices(max, exclude, n) {
  const set = new Set(exclude);
  const picks = [];
  while (picks.length < n) {
    const idx = Math.floor(Math.random() * max);
    if (set.has(idx)) continue;
    set.add(idx);
    picks.push(idx);
  }
  return picks;
}

async function scoreStrategy(strategy) {
  try {
    const result = await evaluate(strategy, apiKey);
    return {
      score: result.aggregate.score,
      aggregate: result.aggregate,
    };
  } catch (err) {
    return { score: 0, error: err.message };
  }
}

mkdirSync("results_de", { recursive: true });

console.log(`\n🔬 Differential Evolution`);
console.log(`   Generations: ${GENERATIONS} | Population: ${POP_SIZE} | API key: ${apiKey.slice(0, 8)}...`);

let population = Array.from({ length: POP_SIZE }, () => {
  const strategy = randomStrategy();
  return { strategy, vector: toVector(strategy), score: 0 };
});

// Initial scoring
for (let i = 0; i < population.length; i++) {
  const scored = await scoreStrategy(population[i].strategy);
  population[i] = { ...population[i], ...scored };
  console.log(`  init[${i + 1}/${POP_SIZE}] score=${population[i].score.toFixed(4)}`);
}

const log = [];
let best = population.slice().sort((a, b) => b.score - a.score)[0];

for (let gen = 1; gen <= GENERATIONS; gen++) {
  console.log(`\n[DE gen ${gen}/${GENERATIONS}]`);
  const nextPop = [];

  for (let i = 0; i < POP_SIZE; i++) {
    const [aIdx, bIdx, cIdx] = pickDistinctIndices(POP_SIZE, [i], 3);
    const a = population[aIdx].vector;
    const b = population[bIdx].vector;
    const c = population[cIdx].vector;

    const mutant = Array.from({ length: DIM }, (_, d) => a[d] + F * (b[d] - c[d]));
    const jRand = Math.floor(Math.random() * DIM);
    const trialVec = Array.from({ length: DIM }, (_, d) => {
      if (Math.random() < CR || d === jRand) return Math.max(0, Math.min(1, mutant[d]));
      return population[i].vector[d];
    });

    const trialStrategy = fromVector(trialVec);
    const trialScored = await scoreStrategy(trialStrategy);

    const parent = population[i];
    const winner = (trialScored.score >= parent.score)
      ? { strategy: trialStrategy, vector: trialVec, ...trialScored }
      : parent;

    nextPop.push(winner);
    if (winner.score > best.score) {
      best = winner;
      console.log(`  ✅ new best ${best.score.toFixed(4)} at gen ${gen}, idx ${i + 1}`);
    }
    console.log(`  idx ${i + 1}: parent=${parent.score.toFixed(4)} trial=${trialScored.score.toFixed(4)} winner=${winner.score.toFixed(4)}`);
  }

  population = nextPop;
  const genBest = population.slice().sort((a, b) => b.score - a.score)[0];
  log.push({
    generation: gen,
    bestScore: genBest.score,
    bestStrategy: genBest.strategy,
    population: population.map(p => ({ score: p.score, strategy: p.strategy, aggregate: p.aggregate })),
  });
  writeFileSync("results_de/log.json", JSON.stringify(log, null, 2));
}

writeFileSync(
  "results_de/best_strategy.json",
  JSON.stringify(
    {
      _meta: { method: "differential-evolution", score: best.score },
      ...best.strategy,
    },
    null,
    2
  )
);

console.log(`\n${"═".repeat(60)}`);
console.log("DIFFERENTIAL EVOLUTION COMPLETE");
console.log(`${"═".repeat(60)}`);
console.log(`Best score=${best.score.toFixed(4)}`);
console.log(JSON.stringify(best.strategy, null, 2));
