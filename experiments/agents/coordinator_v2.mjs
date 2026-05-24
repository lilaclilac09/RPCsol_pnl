/**
 * V2 Autoresearch Coordinator
 *
 * Same loop as coordinator.mjs but operates on V2 algorithm,
 * strategy_v2.json, results_v2/, and history_v2/ directories.
 *
 * Usage:
 *   node coordinator_v2.mjs <api-key> [generations=3] [parallel=4]
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { HYPOTHESIS_REGISTRY, resolveDynamicHypothesis } from "./agent_v2.mjs";

const apiKey      = process.argv[2] ?? process.env.HELIUS_API_KEY;
const GENERATIONS = parseInt(process.argv[3] ?? "3", 10);
const PARALLEL    = parseInt(process.argv[4] ?? "4", 10);

if (!apiKey) {
  console.error("Usage: node coordinator_v2.mjs <api-key> [generations] [parallel]");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────

function spawnAgent(hypothesisName) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["agent_v2.mjs", hypothesisName, apiKey], {
      stdio: "inherit",
      cwd:   process.cwd(),
    });
    child.on("exit", code => code === 0 ? resolve(hypothesisName) : reject(new Error(`agent ${hypothesisName} exited ${code}`)));
    child.on("error", reject);
  });
}

async function runBatch(hypothesisNames) {
  const results = [];
  for (let i = 0; i < hypothesisNames.length; i += PARALLEL) {
    const batch = hypothesisNames.slice(i, i + PARALLEL);
    console.log(`\n▶ Batch: [${batch.join(", ")}]`);
    await Promise.allSettled(batch.map(h => spawnAgent(h)));
    for (const name of batch) {
      try {
        const r = JSON.parse(readFileSync(`results_v2/${name}.json`, "utf8"));
        results.push(r);
      } catch {}
    }
  }
  return results;
}

function deriveNextHypotheses(allResults, generation) {
  if (allResults.length === 0) return HYPOTHESIS_REGISTRY.map(h => h.name);

  const ranked = [...allResults].sort((a, b) =>
    (b.aggregate?.score ?? 0) - (a.aggregate?.score ?? 0)
  );
  const top    = ranked.slice(0, 3);
  const winner = top[0]?.strategy ?? {};

  console.log("\n📊 Generation results:");
  for (const r of ranked) {
    const score = r.aggregate?.score?.toFixed(3) ?? "N/A";
    const ms    = r.aggregate?.avgLatencyMs?.toFixed(0) ?? "?";
    const rpc   = r.aggregate?.totalRpc ?? "?";
    console.log(`  ${r.hypothesisName.padEnd(35)} score=${score}  ${ms}ms  rpc=${rpc}`);
  }

  const next = [];

  if (winner.anchorSize) {
    const a = winner.anchorSize;
    if (a > 50)  next.push(`gen${generation}-anchor-${Math.max(50, a - 50)}`);
    if (a < 300) next.push(`gen${generation}-anchor-${Math.min(300, a + 50)}`);
  }
  if (winner.windowSize) {
    const w = winner.windowSize;
    if (w > 50)  next.push(`gen${generation}-window-${Math.max(50, w - 25)}`);
    if (w < 200) next.push(`gen${generation}-window-${Math.min(200, w + 25)}`);
  }
  if (winner.maxConcurrency) {
    const c = winner.maxConcurrency;
    next.push(`gen${generation}-concurrency-${Math.max(4, c - 4)}`);
    next.push(`gen${generation}-concurrency-${c + 4}`);
  }
  if (top[1]) next.push(`gen${generation}-cross-top2`);
  next.push("baseline");

  return next;
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n🔬 V2 Autoresearch coordinator`);
console.log(`   Generations: ${GENERATIONS}  Parallel: ${PARALLEL}  API key: ${apiKey.slice(0, 8)}...`);

mkdirSync("results_v2", { recursive: true });
mkdirSync("history_v2", { recursive: true });

let hypothesesToRun = HYPOTHESIS_REGISTRY.map(h => h.name);
let allTimeResults  = [];

for (let gen = 0; gen < GENERATIONS; gen++) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`GENERATION ${gen + 1} / ${GENERATIONS}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Hypotheses: ${hypothesesToRun.join(", ")}`);

  // Register dynamic hypotheses
  for (const name of hypothesesToRun) {
    if (!HYPOTHESIS_REGISTRY.find(h => h.name === name)) {
      HYPOTHESIS_REGISTRY.push(resolveDynamicHypothesis(name));
    }
  }

  const genResults = await runBatch(hypothesesToRun);
  allTimeResults   = [...allTimeResults, ...genResults];

  const sorted = [...genResults].sort((a, b) =>
    (b.aggregate?.score ?? 0) - (a.aggregate?.score ?? 0)
  );
  const winner = sorted[0];

  if (winner) {
    const currentMeta = (() => {
      try { return JSON.parse(readFileSync("strategy_v2.json", "utf8"))._meta ?? {}; }
      catch { return {}; }
    })();

    const isImprovement = (winner.aggregate?.score ?? 0) > (currentMeta.score ?? 0);
    if (isImprovement) {
      writeFileSync("strategy_v2.json", JSON.stringify({
        _meta: {
          generation: gen + 1,
          score:      winner.aggregate.score,
          winnerHypothesis: winner.hypothesisName,
          notes: `Gen ${gen + 1} winner: ${winner.description ?? ""} — score=${winner.aggregate.score.toFixed(3)} avgMs=${winner.aggregate.avgLatencyMs.toFixed(0)}`,
        },
        ...winner.strategy,
      }, null, 2));
      console.log(`\n✅ New best: ${winner.hypothesisName} (score=${winner.aggregate.score.toFixed(3)})`);
    } else {
      console.log(`\n⏸ No improvement (best was ${winner.hypothesisName})`);
    }

    writeFileSync(
      `history_v2/gen${gen + 1}.json`,
      JSON.stringify({ generation: gen + 1, results: genResults, winner: winner.hypothesisName }, null, 2)
    );
  }

  if (gen < GENERATIONS - 1) {
    hypothesesToRun = deriveNextHypotheses(allTimeResults, gen + 2);
    console.log(`\n▶ Next hypotheses: ${hypothesesToRun.join(", ")}`);
  }
}

console.log(`\n${"═".repeat(60)}`);
console.log("V2 AUTORESEARCH COMPLETE");
console.log(`${"═".repeat(60)}`);

const finalStrategy = JSON.parse(readFileSync("strategy_v2.json", "utf8"));
console.log("\nBest V2 strategy:");
console.log(JSON.stringify(finalStrategy, null, 2));

const allScored = allTimeResults
  .filter(r => r.aggregate?.score)
  .sort((a, b) => b.aggregate.score - a.aggregate.score);

console.log("\nAll-time V2 leaderboard:");
for (const r of allScored.slice(0, 10)) {
  console.log(
    `  ${r.hypothesisName.padEnd(38)} ` +
    `score=${r.aggregate.score.toFixed(3)}  ` +
    `${r.aggregate.avgLatencyMs.toFixed(0)}ms  ` +
    `rpc=${r.aggregate.totalRpc}`
  );
}
