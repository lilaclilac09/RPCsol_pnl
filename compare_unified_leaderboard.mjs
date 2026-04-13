/**
 * Unified apples-to-apples benchmark across algorithm families.
 *
 * Compares V2/V3/V4/V8 and Codex variants using repeated runs under
 * identical current conditions.
 *
 * Usage:
 *   node compare_unified_leaderboard.mjs <api-key> [repeats=3]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { evaluate as evalV2 } from "./eval_v2.mjs";
import { evaluate as evalV3 } from "./eval_v3.mjs";
import { evaluate as evalV4 } from "./eval_v4.mjs";
import { evaluate as evalV8 } from "./eval_v8.mjs";
import { evaluate as evalCodex } from "./eval_codex.mjs";

const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
const REPEATS = parseInt(process.argv[3] ?? "3", 10);

if (!apiKey) {
  console.error("Usage: node compare_unified_leaderboard.mjs <api-key> [repeats=3]");
  process.exit(1);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
  return s[i];
}

function round(v, d = 4) {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

const candidates = [
  {
    id: "v2-bayes",
    label: "V2 Bayesian",
    evalFn: evalV2,
    strategyPath: "strategy_v2_best.json",
    extract: s => ({
      anchorSize: s.anchorSize,
      windowSize: s.windowSize,
      sigPageSize: s.sigPageSize,
      maxSigPages: s.maxSigPages,
      maxConcurrency: s.maxConcurrency,
      useContinuityOracle: s.useContinuityOracle,
      skipZeroDelta: s.skipZeroDelta,
    }),
  },
  {
    id: "v2-codex-sa",
    label: "V2 Codex SA",
    evalFn: evalV2,
    strategyPath: "results_sa/best_strategy.json",
    extract: s => ({
      anchorSize: s.anchorSize,
      windowSize: s.windowSize,
      sigPageSize: s.sigPageSize,
      maxSigPages: s.maxSigPages,
      maxConcurrency: s.maxConcurrency,
      useContinuityOracle: s.useContinuityOracle,
      skipZeroDelta: s.skipZeroDelta,
    }),
  },
  {
    id: "v3-bayes",
    label: "V3 Bayesian",
    evalFn: evalV3,
    strategyPath: "results_bayes_v3/best_strategy.json",
    extract: s => ({
      anchorSize: s.anchorSize,
      windowSize: s.windowSize,
      sigPageSize: s.sigPageSize,
      maxSigPages: s.maxSigPages,
      maxConcurrency: s.maxConcurrency,
      skipZeroDelta: s.skipZeroDelta,
    }),
  },
  {
    id: "v3-prime",
    label: "V3 PRIME",
    evalFn: evalV3,
    strategyPath: "results_prime_v3/best_strategy.json",
    optional: true,
    extract: s => ({
      anchorSize: s.anchorSize,
      windowSize: s.windowSize,
      sigPageSize: s.sigPageSize,
      maxSigPages: s.maxSigPages,
      maxConcurrency: s.maxConcurrency,
      skipZeroDelta: s.skipZeroDelta,
    }),
  },
  {
    id: "v4-bayes",
    label: "V4 Bayesian",
    evalFn: evalV4,
    strategyPath: "results_bayes_v4/best_strategy.json",
    extract: s => ({
      anchorSize: s.anchorSize,
      windowSize: s.windowSize,
      windowTarget: s.windowTarget,
      sigPageSize: s.sigPageSize,
      maxConcurrency: s.maxConcurrency,
      skipZeroDelta: s.skipZeroDelta,
    }),
  },
  {
    id: "v4-prime",
    label: "V4 PRIME",
    evalFn: evalV4,
    strategyPath: "results_prime_v4/best_strategy.json",
    optional: true,
    extract: s => ({
      anchorSize: s.anchorSize,
      windowSize: s.windowSize,
      windowTarget: s.windowTarget,
      sigPageSize: s.sigPageSize,
      maxConcurrency: s.maxConcurrency,
      skipZeroDelta: s.skipZeroDelta,
    }),
  },
  {
    id: "v8-bayes",
    label: "V8 Bayesian",
    evalFn: evalV8,
    strategyPath: "results_bayes_v8/best_strategy.json",
    extract: s => ({
      anchorSize: s.anchorSize,
      windowSize: s.windowSize,
      sigPageSize: s.sigPageSize,
      maxSigPages: s.maxSigPages,
      maxConcurrency: s.maxConcurrency,
      skipZeroDelta: s.skipZeroDelta,
    }),
  },
  {
    id: "codex-default",
    label: "Codex blockTime default",
    evalFn: evalCodex,
    strategyPath: null,
    extract: () => ({ windowTarget: 80, maxConcurrency: 12 }),
  },
  {
    id: "codex-bayes",
    label: "Codex blockTime BO",
    evalFn: evalCodex,
    strategyPath: "results_bayes_codex/best_strategy.json",
    optional: true,
    extract: s => ({ windowTarget: s.windowTarget, maxConcurrency: s.maxConcurrency }),
  },
];

mkdirSync("results_unified", { recursive: true });

const details = [];

for (const c of candidates) {
  const raw = c.strategyPath ? readJson(c.strategyPath) : {};
  if (c.strategyPath && !raw) {
    if (!c.optional) console.log(`[skip] ${c.label} missing strategy file ${c.strategyPath}`);
    continue;
  }
  const strategy = c.extract(raw || {});
  const runs = [];

  for (let i = 1; i <= REPEATS; i++) {
    const res = await c.evalFn(strategy, apiKey);
    runs.push({ repeat: i, aggregate: res.aggregate, wallets: res.results });
    console.log(`[${c.label}] ${i}/${REPEATS} score=${res.aggregate.score.toFixed(4)} avgMs=${res.aggregate.avgLatencyMs.toFixed(0)} rpc=${res.aggregate.totalRpc}`);
  }

  const scores = runs.map(r => r.aggregate.score);
  const ms = runs.map(r => r.aggregate.avgLatencyMs);
  const rpc = runs.map(r => r.aggregate.totalRpc);
  const comp = runs.map(r => r.aggregate.completeness);

  details.push({
    id: c.id,
    label: c.label,
    strategy,
    summary: {
      repeats: REPEATS,
      meanScore: round(mean(scores), 4),
      stdScore: round(std(scores), 4),
      p50Score: round(pct(scores, 50), 4),
      p90Score: round(pct(scores, 90), 4),
      meanAvgMs: round(mean(ms), 1),
      p90AvgMs: round(pct(ms, 90), 1),
      meanRpc: round(mean(rpc), 1),
      meanCompleteness: round(mean(comp), 4),
      minScore: round(Math.min(...scores), 4),
      maxScore: round(Math.max(...scores), 4),
      minAvgMs: round(Math.min(...ms), 1),
      maxAvgMs: round(Math.max(...ms), 1),
    },
    failureModes: [],
    runs,
  });
}

for (const d of details) {
  const fm = [];
  const low = d.runs.filter(r => r.aggregate.score < 0.4).length;
  const p50 = d.summary.p50Score;
  if (low > 0) fm.push(`score<0.4 on ${low}/${d.summary.repeats} runs`);
  if ((d.summary.maxAvgMs / Math.max(1, d.summary.minAvgMs)) > 1.5) fm.push("latency jitter >1.5x between min/max runs");
  if (d.summary.stdScore > 0.08) fm.push("high score variance (std > 0.08)");
  if (d.summary.meanCompleteness < 1) fm.push("incomplete runs detected");
  if (fm.length === 0) fm.push("no major instability in sampled repeats");
  if (p50 < 0.45) fm.push("median score below 0.45 in current conditions");
  d.failureModes = fm;
}

const leaderboard = details
  .slice()
  .sort((a, b) => b.summary.meanScore - a.summary.meanScore)
  .map((d, i) => ({
    rank: i + 1,
    id: d.id,
    label: d.label,
    ...d.summary,
    strategy: d.strategy,
  }));

const report = {
  generatedAt: new Date().toISOString(),
  scope: "unified-current-conditions",
  repeatsPerCandidate: REPEATS,
  leaderboard,
  details,
};

writeFileSync("results_unified/leaderboard_unified.json", JSON.stringify(report, null, 2));

const csvHeader = [
  "rank",
  "label",
  "meanScore",
  "stdScore",
  "p50Score",
  "meanAvgMs",
  "p90AvgMs",
  "meanRpc",
  "meanCompleteness",
  "minScore",
  "maxScore",
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
  r.minScore,
  r.maxScore,
].join(","));

writeFileSync("results_unified/leaderboard_unified.csv", [csvHeader, ...csvRows].join("\n"));

const lines = [];
lines.push("# Unified Apples-to-Apples Leaderboard");
lines.push("");
lines.push(`Generated: ${report.generatedAt}`);
lines.push(`Repeats per candidate: ${REPEATS}`);
lines.push("");
lines.push("| Rank | Candidate | Mean Score | Std | P50 | Mean AvgMs | P90 AvgMs | Mean RPC | Completeness |");
lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
for (const r of leaderboard) {
  lines.push(`| ${r.rank} | ${r.label} | ${r.meanScore.toFixed(4)} | ${r.stdScore.toFixed(4)} | ${r.p50Score.toFixed(4)} | ${r.meanAvgMs.toFixed(1)} | ${r.p90AvgMs.toFixed(1)} | ${r.meanRpc.toFixed(1)} | ${r.meanCompleteness.toFixed(2)} |`);
}
lines.push("");
lines.push("## Failure Modes");
for (const d of details) {
  lines.push("");
  lines.push(`### ${d.label}`);
  for (const f of d.failureModes) lines.push(`- ${f}`);
}

writeFileSync("results_unified/leaderboard_unified.md", lines.join("\n"));

console.log("\nUnified leaderboard artifacts:");
console.log("- results_unified/leaderboard_unified.json");
console.log("- results_unified/leaderboard_unified.csv");
console.log("- results_unified/leaderboard_unified.md");
