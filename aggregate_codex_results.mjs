/**
 * Aggregate Codex-only experiment outputs into dashboard-friendly artifacts.
 *
 * Usage:
 *   node aggregate_codex_results.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const outDir = "results_codex";
mkdirSync(outDir, { recursive: true });

const methods = [
  { name: "tpe", label: "TPE-style", best: "results_tpe/best_strategy.json", log: "results_tpe/log.json" },
  { name: "differential-evolution", label: "Differential Evolution", best: "results_de/best_strategy.json", log: "results_de/log.json" },
  { name: "simulated-annealing", label: "Simulated Annealing", best: "results_sa/best_strategy.json", log: "results_sa/log.json" },
];

function safeReadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function summarizeMethod(m) {
  const best = safeReadJson(m.best);
  const log = safeReadJson(m.log);
  if (!best) return null;

  let score = best?._meta?.score ?? null;
  let trialRef = best?._meta?.trial ?? best?._meta?.gen ?? null;
  let avgMs = null;
  let totalRpc = null;
  let evaluations = null;

  if (Array.isArray(log) && log.length > 0) {
    evaluations = log.length;
    const flat = [];
    for (const row of log) {
      if (typeof row?.score === "number") flat.push(row);
      if (Array.isArray(row?.population)) {
        for (const p of row.population) {
          if (typeof p?.score === "number") {
            flat.push({ score: p.score, aggregate: p.aggregate, strategy: p.strategy });
          }
        }
      }
    }

    if (flat.length > 0) {
      const top = flat.sort((a, b) => b.score - a.score)[0];
      score = score ?? top.score;
      avgMs = top?.aggregate?.avgLatencyMs ?? null;
      totalRpc = top?.aggregate?.totalRpc ?? null;
    }
  }

  return {
    method: m.name,
    label: m.label,
    score,
    avgMs,
    totalRpc,
    evaluations,
    trialRef,
    strategy: {
      anchorSize: best.anchorSize,
      windowSize: best.windowSize,
      maxConcurrency: best.maxConcurrency,
      useContinuityOracle: best.useContinuityOracle,
      skipZeroDelta: best.skipZeroDelta,
      sigPageSize: best.sigPageSize,
      maxSigPages: best.maxSigPages,
    },
  };
}

const rows = methods.map(summarizeMethod).filter(Boolean).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

const now = new Date().toISOString();
const report = {
  generatedAt: now,
  scope: "codex-only",
  rows,
};

writeFileSync(`${outDir}/leaderboard.json`, JSON.stringify(report, null, 2));

const csvHeader = [
  "rank",
  "method",
  "score",
  "avgMs",
  "totalRpc",
  "evaluations",
  "anchorSize",
  "windowSize",
  "maxConcurrency",
  "useContinuityOracle",
  "skipZeroDelta",
  "sigPageSize",
  "maxSigPages",
].join(",");

const csvRows = rows.map((r, i) => [
  i + 1,
  r.method,
  r.score ?? "",
  r.avgMs ?? "",
  r.totalRpc ?? "",
  r.evaluations ?? "",
  r.strategy.anchorSize,
  r.strategy.windowSize,
  r.strategy.maxConcurrency,
  r.strategy.useContinuityOracle,
  r.strategy.skipZeroDelta,
  r.strategy.sigPageSize,
  r.strategy.maxSigPages,
].join(","));

writeFileSync(`${outDir}/leaderboard.csv`, [csvHeader, ...csvRows].join("\n"));

const md = [
  "# Codex-only Results",
  "",
  `Generated: ${now}`,
  "",
  "| Rank | Method | Score | AvgMs | RPC | Evaluations | Key config |",
  "|---|---|---:|---:|---:|---:|---|",
  ...rows.map((r, i) => {
    const key = `anchor=${r.strategy.anchorSize} window=${r.strategy.windowSize} c=${r.strategy.maxConcurrency} oracle=${r.strategy.useContinuityOracle ? "on" : "off"} skipZero=${r.strategy.skipZeroDelta ? "on" : "off"}`;
    return `| ${i + 1} | ${r.label} | ${(r.score ?? 0).toFixed(4)} | ${r.avgMs ?? "-"} | ${r.totalRpc ?? "-"} | ${r.evaluations ?? "-"} | ${key} |`;
  }),
  "",
  "## Notes",
  "- This file includes only methods executed by Codex in this continuation run.",
  "- Previous Claude-generated experiments are intentionally excluded.",
].join("\n");

writeFileSync(`${outDir}/leaderboard.md`, md);

console.log("\nCodex leaderboard written:");
console.log(`- ${outDir}/leaderboard.json`);
console.log(`- ${outDir}/leaderboard.csv`);
console.log(`- ${outDir}/leaderboard.md`);
