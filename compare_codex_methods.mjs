/**
 * Apples-to-apples benchmark for Codex-generated methods.
 *
 * Re-evaluates each method's best strategy with identical evaluator settings
 * across repeated runs to estimate mean performance and stability.
 *
 * Usage:
 *   node compare_codex_methods.mjs <api-key> [repeats=5]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { evaluate } from "./eval_v2.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const REPEATS = parseInt(process.argv[3] ?? "5", 10);

if (!apiKey) {
  console.error("Usage: node compare_codex_methods.mjs <api-key> [repeats=5]");
  process.exit(1);
}

const methods = [
  { key: "tpe", label: "TPE-style", bestPath: "results_tpe/best_strategy.json" },
  { key: "de", label: "Differential Evolution", bestPath: "results_de/best_strategy.json" },
  { key: "sa", label: "Simulated Annealing", bestPath: "results_sa/best_strategy.json" },
];

function safeRead(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function round(v, d = 4) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function summarizeFailureModes(runs) {
  const completions = runs.map(r => r.aggregate.completeness);
  const latencies = runs.map(r => r.aggregate.avgLatencyMs);
  const scores = runs.map(r => r.aggregate.score);
  const rpcs = runs.map(r => r.aggregate.totalRpc);

  const medianLatency = percentile(latencies, 50);
  const degradedRuns = runs.filter(r => r.aggregate.score < 0.4).length;
  const spikeRuns = runs.filter(r => r.aggregate.avgLatencyMs > 1.5 * medianLatency).length;
  const incompleteRuns = completions.filter(c => c < 1).length;

  const modes = [];
  if (incompleteRuns > 0) modes.push(`Completeness drop on ${incompleteRuns}/${runs.length} runs`);
  if (spikeRuns > 0) modes.push(`Latency spikes (>1.5x median) on ${spikeRuns}/${runs.length} runs`);
  if (degradedRuns > 0) modes.push(`Score degradation (<0.4) on ${degradedRuns}/${runs.length} runs`);

  // Sensitivity hints from variation
  const scoreCv = mean(scores) > 0 ? stddev(scores) / mean(scores) : 0;
  const rpcCv = mean(rpcs) > 0 ? stddev(rpcs) / mean(rpcs) : 0;
  if (scoreCv > 0.2) modes.push("High score variance across repeats (sensitive to RPC conditions)");
  if (rpcCv > 0.2) modes.push("High RPC-call variance across repeats (path instability)");

  if (modes.length === 0) modes.push("No major instability observed in sampled repeats");
  return modes;
}

mkdirSync("results_codex", { recursive: true });

const detail = [];

for (const m of methods) {
  const best = safeRead(m.bestPath);
  if (!best) continue;

  const strategy = {
    anchorSize: best.anchorSize,
    windowSize: best.windowSize,
    sigPageSize: best.sigPageSize,
    maxSigPages: best.maxSigPages,
    maxConcurrency: best.maxConcurrency,
    useContinuityOracle: best.useContinuityOracle,
    skipZeroDelta: best.skipZeroDelta,
  };

  const runs = [];
  for (let i = 1; i <= REPEATS; i++) {
    const result = await evaluate(strategy, apiKey);
    runs.push({ repeat: i, aggregate: result.aggregate, walletResults: result.results });
    console.log(`[${m.label}] repeat ${i}/${REPEATS} score=${result.aggregate.score.toFixed(4)} avgMs=${result.aggregate.avgLatencyMs.toFixed(0)} rpc=${result.aggregate.totalRpc}`);
  }

  const scores = runs.map(r => r.aggregate.score);
  const latencies = runs.map(r => r.aggregate.avgLatencyMs);
  const rpcs = runs.map(r => r.aggregate.totalRpc);
  const completeness = runs.map(r => r.aggregate.completeness);

  detail.push({
    method: m.key,
    label: m.label,
    strategy,
    summary: {
      repeats: REPEATS,
      meanScore: round(mean(scores), 4),
      stdScore: round(stddev(scores), 4),
      p50Score: round(percentile(scores, 50), 4),
      p90Score: round(percentile(scores, 90), 4),
      meanAvgMs: round(mean(latencies), 1),
      p50AvgMs: round(percentile(latencies, 50), 1),
      p90AvgMs: round(percentile(latencies, 90), 1),
      meanRpc: round(mean(rpcs), 1),
      meanCompleteness: round(mean(completeness), 4),
    },
    failureModes: summarizeFailureModes(runs),
    runs,
  });
}

const leaderboard = detail
  .slice()
  .sort((a, b) => b.summary.meanScore - a.summary.meanScore)
  .map((x, i) => ({
    rank: i + 1,
    method: x.method,
    label: x.label,
    meanScore: x.summary.meanScore,
    stdScore: x.summary.stdScore,
    p50Score: x.summary.p50Score,
    meanAvgMs: x.summary.meanAvgMs,
    p90AvgMs: x.summary.p90AvgMs,
    meanRpc: x.summary.meanRpc,
    meanCompleteness: x.summary.meanCompleteness,
    strategy: x.strategy,
  }));

const report = {
  generatedAt: new Date().toISOString(),
  scope: "codex-only",
  repeatsPerMethod: REPEATS,
  leaderboard,
  methods: detail,
};

writeFileSync("results_codex/apples_to_apples.json", JSON.stringify(report, null, 2));

const csvHeader = [
  "rank",
  "method",
  "meanScore",
  "stdScore",
  "p50Score",
  "meanAvgMs",
  "p90AvgMs",
  "meanRpc",
  "meanCompleteness",
  "anchorSize",
  "windowSize",
  "maxConcurrency",
  "useContinuityOracle",
  "skipZeroDelta",
].join(",");

const csvRows = leaderboard.map(r => [
  r.rank,
  r.label,
  r.meanScore,
  r.stdScore,
  r.p50Score,
  r.meanAvgMs,
  r.p90AvgMs,
  r.meanRpc,
  r.meanCompleteness,
  r.strategy.anchorSize,
  r.strategy.windowSize,
  r.strategy.maxConcurrency,
  r.strategy.useContinuityOracle,
  r.strategy.skipZeroDelta,
].join(","));

writeFileSync("results_codex/apples_to_apples.csv", [csvHeader, ...csvRows].join("\n"));

const mdLines = [];
mdLines.push("# Codex Apples-to-Apples Leaderboard");
mdLines.push("");
mdLines.push(`Generated: ${report.generatedAt}`);
mdLines.push(`Repeats per method: ${REPEATS}`);
mdLines.push("");
mdLines.push("| Rank | Method | Mean Score | Std | Mean AvgMs | P90 AvgMs | Mean RPC | Completeness | Key config |");
mdLines.push("|---|---|---:|---:|---:|---:|---:|---:|---|");
for (const r of leaderboard) {
  const key = `anchor=${r.strategy.anchorSize} window=${r.strategy.windowSize} c=${r.strategy.maxConcurrency} oracle=${r.strategy.useContinuityOracle ? "on" : "off"} skipZero=${r.strategy.skipZeroDelta ? "on" : "off"}`;
  mdLines.push(`| ${r.rank} | ${r.label} | ${r.meanScore.toFixed(4)} | ${r.stdScore.toFixed(4)} | ${r.meanAvgMs.toFixed(1)} | ${r.p90AvgMs.toFixed(1)} | ${r.meanRpc.toFixed(1)} | ${r.meanCompleteness.toFixed(2)} | ${key} |`);
}

mdLines.push("");
mdLines.push("## Per-method failure modes");
for (const m of detail) {
  mdLines.push("");
  mdLines.push(`### ${m.label}`);
  for (const fm of m.failureModes) mdLines.push(`- ${fm}`);
}

writeFileSync("results_codex/apples_to_apples.md", mdLines.join("\n"));

console.log("\nApples-to-apples artifacts written:");
console.log("- results_codex/apples_to_apples.json");
console.log("- results_codex/apples_to_apples.csv");
console.log("- results_codex/apples_to_apples.md");
