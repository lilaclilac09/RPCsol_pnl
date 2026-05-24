/**
 * Autoresearch Coordinator
 *
 * Implements the research loop:
 *   1. Spawn N parallel agents, each with a distinct hypothesis
 *   2. Collect results when all agents complete
 *   3. Identify the winning strategy (highest score)
 *   4. Update strategy.json with the winner
 *   5. Generate next-generation hypotheses informed by what worked
 *   6. Repeat for G generations
 *
 * Usage:
 *   node coordinator.mjs <api-key> [generations=3] [parallel=4]
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { HYPOTHESIS_REGISTRY, resolveDynamicHypothesis } from "./agent.mjs";

const apiKey      = process.argv[2] ?? process.env.HELIUS_API_KEY;
const GENERATIONS = parseInt(process.argv[3] ?? "3", 10);
const PARALLEL    = parseInt(process.argv[4] ?? "4", 10);  // agents per batch

if (!apiKey) { console.error("Usage: node coordinator.mjs <api-key> [generations] [parallel]"); process.exit(1); }

// ──────────────────────────────────────────────────────────────────────────────
// Spawn a single agent as a child process and await completion
// ──────────────────────────────────────────────────────────────────────────────

function spawnAgent(hypothesisName) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["agent.mjs", hypothesisName, apiKey], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("exit", (code) => {
      if (code === 0) resolve(hypothesisName);
      else reject(new Error(`agent ${hypothesisName} exited ${code}`));
    });
    child.on("error", reject);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Run a batch of agents in parallel (cap at PARALLEL)
// ──────────────────────────────────────────────────────────────────────────────

async function runBatch(hypothesisNames) {
  const results = [];
  for (let i = 0; i < hypothesisNames.length; i += PARALLEL) {
    const batch = hypothesisNames.slice(i, i + PARALLEL);
    console.log(`\n▶ Running batch: [${batch.join(", ")}]`);
    await Promise.allSettled(batch.map(h => spawnAgent(h)));
    // Read results from disk
    for (const name of batch) {
      try {
        const r = JSON.parse(readFileSync(`results/${name}.json`, "utf8"));
        results.push(r);
      } catch {}
    }
  }
  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Generate next-gen hypotheses from what worked
// ──────────────────────────────────────────────────────────────────────────────

function deriveNextHypotheses(allResults, generation) {
  if (allResults.length === 0) return HYPOTHESIS_REGISTRY.map(h => h.name);

  // Sort by score descending
  const ranked = [...allResults].sort((a, b) =>
    (b.aggregate?.score ?? 0) - (a.aggregate?.score ?? 0)
  );

  const top  = ranked.slice(0, 3);
  const worst= ranked.at(-1);

  const insights = [];
  console.log("\n📊 Generation results:");
  for (const r of ranked) {
    const score = r.aggregate?.score?.toFixed(3) ?? "N/A";
    const ms    = r.aggregate?.avgLatencyMs?.toFixed(0) ?? "?";
    const rpc   = r.aggregate?.totalRpc ?? "?";
    console.log(`  ${r.hypothesisName.padEnd(30)} score=${score}  ${ms}ms  rpc=${rpc}`);
  }

  // Read what the top strategies have in common vs the bottom
  if (top[0]) {
    const best = top[0];
    insights.push(`  Winner: ${best.hypothesisName} (score=${best.aggregate.score.toFixed(3)})`);
    insights.push(`  Key params: golomb=${best.strategy.golombOrder} concurrency=${best.strategy.maxConcurrency} budget=${best.strategy.maxRpcCalls} oracle=${best.strategy.useContinuityOracle}`);
  }
  console.log("\n🔬 Insights:", insights.join("\n"));

  // Generate new hypotheses by interpolating between top performers
  // and exploring around the winner's parameters
  const winner = top[0]?.strategy ?? {};
  const nextHypotheses = [];

  // Neighbour exploration around winner's key knobs
  if (winner.golombOrder) {
    const g = winner.golombOrder;
    if (g > 4)  nextHypotheses.push(`gen${generation}-golomb-${g-1}`);
    if (g < 8)  nextHypotheses.push(`gen${generation}-golomb-${g+1}`);
  }
  if (winner.maxConcurrency) {
    const c = winner.maxConcurrency;
    nextHypotheses.push(`gen${generation}-concurrency-${Math.max(4, c - 4)}`);
    nextHypotheses.push(`gen${generation}-concurrency-${c + 4}`);
  }
  if (winner.maxRpcCalls) {
    const b = winner.maxRpcCalls;
    nextHypotheses.push(`gen${generation}-budget-${Math.round(b * 0.7)}`);
    nextHypotheses.push(`gen${generation}-budget-${Math.round(b * 1.5)}`);
  }

  // Combine top-2 strategies
  if (top[1]) {
    nextHypotheses.push(`gen${generation}-cross-top2`);
  }

  // Always re-run baseline to track drift
  nextHypotheses.push("baseline");

  return nextHypotheses;
}

// Dynamic hypothesis factory: delegates to the shared implementation in agent.mjs
// (agent child processes also use resolveDynamicHypothesis, so both stay in sync)
const resolveHypothesis = resolveDynamicHypothesis;

// ──────────────────────────────────────────────────────────────────────────────
// Main loop
// ──────────────────────────────────────────────────────────────────────────────

console.log(`\n🔬 Autoresearch coordinator`);
console.log(`   Generations: ${GENERATIONS}  Parallel: ${PARALLEL}  API key: ${apiKey.slice(0, 8)}...`);

mkdirSync("results", { recursive: true });
mkdirSync("history", { recursive: true });

// Gen 0: run the full static hypothesis registry
let hypothesesToRun = HYPOTHESIS_REGISTRY.map(h => h.name);
let allTimeResults  = [];

for (let gen = 0; gen < GENERATIONS; gen++) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`GENERATION ${gen + 1} / ${GENERATIONS}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Hypotheses: ${hypothesesToRun.join(", ")}`);

  // Register any dynamic hypotheses
  for (const name of hypothesesToRun) {
    if (!HYPOTHESIS_REGISTRY.find(h => h.name === name)) {
      HYPOTHESIS_REGISTRY.push(resolveHypothesis(name));
    }
  }

  const genResults = await runBatch(hypothesesToRun);
  allTimeResults   = [...allTimeResults, ...genResults];

  // Find best of this generation
  const sorted = [...genResults].sort((a, b) =>
    (b.aggregate?.score ?? 0) - (a.aggregate?.score ?? 0)
  );
  const winner = sorted[0];

  if (winner) {
    // Update strategy.json
    const currentMeta = (() => {
      try { return JSON.parse(readFileSync("strategy.json", "utf8"))._meta ?? {}; }
      catch { return {}; }
    })();

    const isImprovement = (winner.aggregate?.score ?? 0) > (currentMeta.score ?? 0);
    if (isImprovement) {
      const newStrategy = {
        _meta: {
          generation: gen + 1,
          score: winner.aggregate.score,
          winnerHypothesis: winner.hypothesisName,
          notes: `Gen ${gen + 1} winner: ${winner.description ?? ""} — score=${winner.aggregate.score.toFixed(3)} avgMs=${winner.aggregate.avgLatencyMs.toFixed(0)}`,
        },
        ...winner.strategy,
      };
      writeFileSync("strategy.json", JSON.stringify(newStrategy, null, 2));
      console.log(`\n✅ New best strategy: ${winner.hypothesisName} (score=${winner.aggregate.score.toFixed(3)})`);
    } else {
      console.log(`\n⏸ No improvement this generation (best was ${winner.hypothesisName})`);
    }

    // Archive generation results
    writeFileSync(
      `history/gen${gen + 1}.json`,
      JSON.stringify({ generation: gen + 1, results: genResults, winner: winner.hypothesisName }, null, 2)
    );
  }

  // Derive next-gen hypotheses
  if (gen < GENERATIONS - 1) {
    hypothesesToRun = deriveNextHypotheses(allTimeResults, gen + 2);
    console.log(`\n▶ Next generation hypotheses: ${hypothesesToRun.join(", ")}`);
  }
}

// Final summary
console.log(`\n${"═".repeat(60)}`);
console.log("AUTORESEARCH COMPLETE");
console.log(`${"═".repeat(60)}`);

const finalStrategy = JSON.parse(readFileSync("strategy.json", "utf8"));
console.log("\nBest strategy found:");
console.log(JSON.stringify(finalStrategy, null, 2));

const allScored = allTimeResults
  .filter(r => r.aggregate?.score)
  .sort((a, b) => b.aggregate.score - a.aggregate.score);

console.log("\nAll-time leaderboard:");
for (const r of allScored.slice(0, 10)) {
  console.log(
    `  ${r.hypothesisName.padEnd(35)} ` +
    `score=${r.aggregate.score.toFixed(3)}  ` +
    `${r.aggregate.avgLatencyMs.toFixed(0)}ms  ` +
    `rpc=${r.aggregate.totalRpc}`
  );
}
