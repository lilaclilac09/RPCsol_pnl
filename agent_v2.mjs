/**
 * V2 Autoresearch Agent
 *
 * Same pattern as agent.mjs but hypotheses target the V2 algorithm's
 * parameters: anchorSize, sigPageSize, windowSize, maxConcurrency, oracles.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { evaluate } from "./eval_v2.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Hypothesis registry — each entry mutates the strategy to test a specific knob
// ─────────────────────────────────────────────────────────────────────────────

export const HYPOTHESIS_REGISTRY = [
  {
    name: "baseline",
    description: "V2 baseline: anchorSize=100, sigPageSize=1000, windowSize=90, concurrency=12",
    mutate: s => ({ ...s }),
  },

  // ── Anchor size (capped at 100 — Helius full-tx API limit per call) ─────
  {
    name: "anchor-50",
    description: "Smaller anchor (50) — faster anchor calls, more wallets hit Phase 1",
    mutate: s => ({ ...s, anchorSize: 50 }),
  },
  {
    name: "anchor-75",
    description: "Medium anchor (75) — midpoint",
    mutate: s => ({ ...s, anchorSize: 75 }),
  },

  // ── Window size (Phase 2 full-fetch grouping) ────────────────────────────
  {
    name: "window-50",
    description: "Smaller full-fetch windows (50 txns) — more calls but lighter each",
    mutate: s => ({ ...s, windowSize: 50 }),
  },
  {
    name: "window-100",
    description: "Max single-page windows (100 txns) — fits exactly in one API call",
    mutate: s => ({ ...s, windowSize: 100 }),
  },
  {
    name: "window-200",
    description: "Large windows (200 txns) — two pages each, fewer round trips",
    mutate: s => ({ ...s, windowSize: 200 }),
  },

  // ── Concurrency ──────────────────────────────────────────────────────────
  {
    name: "concurrency-6",
    description: "Low concurrency (6) — fewer rate-limit collisions",
    mutate: s => ({ ...s, maxConcurrency: 6 }),
  },
  {
    name: "concurrency-8",
    description: "Medium concurrency (8)",
    mutate: s => ({ ...s, maxConcurrency: 8 }),
  },
  {
    name: "concurrency-16",
    description: "High concurrency (16) — maximize parallel throughput",
    mutate: s => ({ ...s, maxConcurrency: 16 }),
  },
  {
    name: "concurrency-24",
    description: "Very high concurrency (24) — saturate the rate limit",
    mutate: s => ({ ...s, maxConcurrency: 24 }),
  },

  // ── Oracle switches ──────────────────────────────────────────────────────
  {
    name: "no-oracle",
    description: "Disable continuity oracle — always run Phase 1+2",
    mutate: s => ({ ...s, useContinuityOracle: false }),
  },
  {
    name: "include-zero-delta",
    description: "Include zero-delta txns — complete but noisier",
    mutate: s => ({ ...s, skipZeroDelta: false }),
  },

  // ── Combined explorations ────────────────────────────────────────────────
  // ── Combined sweet-spot explorations ────────────────────────────────────
  {
    name: "anchor-75-window-100",
    description: "Trimmed anchors + max single-page windows",
    mutate: s => ({ ...s, anchorSize: 75, windowSize: 100 }),
  },
  {
    name: "anchor-50-window-100-c16",
    description: "Small anchors, max windows, high concurrency — pure parallel throughput",
    mutate: s => ({ ...s, anchorSize: 50, windowSize: 100, maxConcurrency: 16 }),
  },
  {
    name: "anchor-100-window-50-c24",
    description: "Full anchor, small windows, max concurrency — minimise sequential phases",
    mutate: s => ({ ...s, anchorSize: 100, windowSize: 50, maxConcurrency: 24 }),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic hypothesis resolution (for coordinator-generated gen<N>-* names)
// ─────────────────────────────────────────────────────────────────────────────

export function resolveDynamicHypothesis(name) {
  const static_ = HYPOTHESIS_REGISTRY.find(h => h.name === name);
  if (static_) return static_;

  // gen<G>-<param>-<value>
  const genMatch = name.match(/^gen(\d+)-(anchor|window|concurrency|sigpage)-(\d+)$/);
  if (genMatch) {
    const [, , param, valStr] = genMatch;
    const val = parseInt(valStr, 10);
    const paramMap = {
      anchor:      "anchorSize",
      window:      "windowSize",
      concurrency: "maxConcurrency",
      sigpage:     "sigPageSize",
    };
    const key = paramMap[param];
    return {
      name,
      description: `Gen-derived: ${key}=${val}`,
      mutate: s => ({ ...s, [key]: val }),
    };
  }

  // gen<G>-cross-top2
  if (/^gen\d+-cross-top2$/.test(name)) {
    return {
      name,
      description: "Crossover of top-2 V2 results from previous generation",
      mutate: s => {
        try {
          const files   = readdirSync("results_v2").filter(f => f.endsWith(".json"));
          const results = files.map(f => JSON.parse(readFileSync(`results_v2/${f}`, "utf8")));
          const ranked  = results.sort((a, b) => (b.aggregate?.score ?? 0) - (a.aggregate?.score ?? 0));
          const t1 = ranked[0]?.strategy ?? {};
          const t2 = ranked[1]?.strategy ?? {};
          return {
            ...s,
            anchorSize:     Math.round(((t1.anchorSize     ?? s.anchorSize)     + (t2.anchorSize     ?? s.anchorSize))     / 2),
            windowSize:     Math.round(((t1.windowSize     ?? s.windowSize)     + (t2.windowSize     ?? s.windowSize))     / 2),
            maxConcurrency: Math.round(((t1.maxConcurrency ?? s.maxConcurrency) + (t2.maxConcurrency ?? s.maxConcurrency)) / 2),
            useContinuityOracle: t1.useContinuityOracle ?? s.useContinuityOracle,
          };
        } catch { return s; }
      },
    };
  }

  throw new Error(`Unknown V2 hypothesis: ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runAgent(hypothesisName, apiKey) {
  const hypothesis = resolveDynamicHypothesis(hypothesisName);

  const base = JSON.parse(readFileSync("strategy_v2.json", "utf8"));
  delete base._meta;

  const variant = hypothesis.mutate(base);

  console.log(`[v2-agent:${hypothesisName}] evaluating...`);
  const t0     = performance.now();
  const result = await evaluate(variant, apiKey);
  const wallMs = performance.now() - t0;

  const report = {
    hypothesisName,
    description:  hypothesis.description,
    strategy:     variant,
    results:      result.results,
    aggregate:    result.aggregate,
    evalWallMs:   wallMs,
    timestamp:    new Date().toISOString(),
  };

  mkdirSync("results_v2", { recursive: true });
  writeFileSync(`results_v2/${hypothesisName}.json`, JSON.stringify(report, null, 2));

  console.log(
    `[v2-agent:${hypothesisName}] done  score=${result.aggregate.score.toFixed(3)}` +
    `  avgMs=${result.aggregate.avgLatencyMs.toFixed(0)}` +
    `  rpc=${result.aggregate.totalRpc}` +
    `  complete=${(result.aggregate.completeness * 100).toFixed(0)}%`
  );

  return report;
}

// CLI
const _isCLI = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;
const hypothesisName = _isCLI ? process.argv[2] : null;
const apiKey         = _isCLI ? (process.argv[3] ?? process.env.HELIUS_API_KEY) : null;

if (hypothesisName && apiKey) {
  await runAgent(hypothesisName, apiKey);
}
