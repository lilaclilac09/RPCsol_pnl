/**
 * Simulated Annealing with periodic restarts.
 *
 * Usage:
 *   node research_sa.mjs <api-key> [steps=80] [restarts=3]
 */

import { mkdirSync, writeFileSync } from "fs";
import { evaluate } from "./eval_v2.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const STEPS = parseInt(process.argv[3] ?? "80", 10);
const RESTARTS = parseInt(process.argv[4] ?? "3", 10);

if (!apiKey) {
  console.error("Usage: node research_sa.mjs <api-key> [steps=80] [restarts=3]");
  process.exit(1);
}

const PARAMS = [
  { name: "anchorSize", lo: 10, hi: 100, type: "int", step: 10 },
  { name: "windowSize", lo: 20, hi: 100, type: "int", step: 10 },
  { name: "maxConcurrency", lo: 4, hi: 24, type: "int", step: 2 },
  { name: "useContinuityOracle", lo: 0, hi: 1, type: "bool" },
  { name: "skipZeroDelta", lo: 0, hi: 1, type: "bool" },
];

const FIXED = { sigPageSize: 1000, maxSigPages: 20 };

function randomStrategy() {
  const s = { ...FIXED };
  for (const p of PARAMS) {
    if (p.type === "bool") s[p.name] = Math.random() > 0.5;
    else {
      const raw = p.lo + Math.random() * (p.hi - p.lo);
      s[p.name] = Math.round(raw / p.step) * p.step;
      s[p.name] = Math.max(p.lo, Math.min(p.hi, s[p.name]));
    }
  }
  return s;
}

function proposeNeighbor(base, temperature) {
  const s = { ...base };
  for (const p of PARAMS) {
    if (p.type === "bool") {
      const flipProb = Math.max(0.02, 0.25 * temperature);
      if (Math.random() < flipProb) s[p.name] = !s[p.name];
      continue;
    }
    const maxJumps = Math.max(1, Math.ceil(3 * temperature));
    const jumps = Math.floor(Math.random() * (maxJumps * 2 + 1)) - maxJumps;
    const next = s[p.name] + jumps * p.step;
    s[p.name] = Math.max(p.lo, Math.min(p.hi, next));
  }
  return s;
}

async function scoreStrategy(strategy) {
  try {
    const result = await evaluate(strategy, apiKey);
    return {
      strategy,
      score: result.aggregate.score,
      aggregate: result.aggregate,
    };
  } catch (err) {
    return {
      strategy,
      score: 0,
      error: err.message,
    };
  }
}

function acceptanceProb(current, candidate, temp) {
  if (candidate >= current) return 1;
  const delta = candidate - current;
  return Math.exp(delta / Math.max(0.0001, temp));
}

mkdirSync("results_sa", { recursive: true });

const logs = [];
let globalBest = null;

console.log(`\n🔬 Simulated Annealing`);
console.log(`   Steps/restart: ${STEPS} | Restarts: ${RESTARTS} | API key: ${apiKey.slice(0, 8)}...`);

for (let restart = 1; restart <= RESTARTS; restart++) {
  let current = await scoreStrategy(randomStrategy());
  let bestLocal = current;
  if (!globalBest || current.score > globalBest.score) globalBest = current;

  console.log(`\n[SA restart ${restart}/${RESTARTS}] init score=${current.score.toFixed(4)}`);

  for (let step = 1; step <= STEPS; step++) {
    const progress = (step - 1) / Math.max(1, STEPS - 1);
    const temperature = Math.max(0.02, 1.0 - progress); // linear cooling
    const candidateStrategy = proposeNeighbor(current.strategy, temperature);
    const candidate = await scoreStrategy(candidateStrategy);

    const p = acceptanceProb(current.score, candidate.score, temperature);
    if (Math.random() < p) current = candidate;

    if (candidate.score > bestLocal.score) bestLocal = candidate;
    if (!globalBest || candidate.score > globalBest.score) {
      globalBest = candidate;
      console.log(`  ✅ new global best ${globalBest.score.toFixed(4)} at restart ${restart}, step ${step}`);
    }

    logs.push({
      method: "simulated-annealing",
      restart,
      step,
      temperature,
      currentScore: current.score,
      candidateScore: candidate.score,
      bestLocalScore: bestLocal.score,
      bestGlobalScore: globalBest.score,
      strategy: candidate.strategy,
      aggregate: candidate.aggregate,
      error: candidate.error,
    });

    if (step % 5 === 0 || step === STEPS) {
      console.log(`  step ${step}/${STEPS} temp=${temperature.toFixed(2)} cur=${current.score.toFixed(4)} localBest=${bestLocal.score.toFixed(4)}`);
    }

    if (step % 3 === 0 || step === STEPS) {
      writeFileSync("results_sa/log.json", JSON.stringify(logs, null, 2));
    }
  }
}

if (globalBest) {
  writeFileSync(
    "results_sa/best_strategy.json",
    JSON.stringify(
      {
        _meta: { method: "simulated-annealing", score: globalBest.score },
        ...globalBest.strategy,
      },
      null,
      2
    )
  );
}

console.log(`\n${"═".repeat(60)}`);
console.log("SIMULATED ANNEALING COMPLETE");
console.log(`${"═".repeat(60)}`);
if (globalBest) {
  console.log(`Best score=${globalBest.score.toFixed(4)}`);
  console.log(JSON.stringify(globalBest.strategy, null, 2));
}
