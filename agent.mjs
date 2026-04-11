/**
 * Autoresearch Agent
 *
 * Each agent receives a HYPOTHESIS (which strategy knob to mutate and how)
 * and independently:
 *   1. Reads the current best strategy from strategy.json
 *   2. Applies its hypothesis mutation
 *   3. Evaluates the variant against all test wallets
 *   4. Reports results to results/ directory
 *
 * Run directly:
 *   node agent.mjs <hypothesis-name> <api-key>
 *
 * Hypotheses are defined in HYPOTHESIS_REGISTRY below.
 * The coordinator spawns N agents in parallel, one per hypothesis.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { evaluate } from "./eval.mjs";

// ──────────────────────────────────────────────────────────────────────────────
// Hypothesis registry
// Each entry: { name, description, mutate(strategy) -> strategy }
// ──────────────────────────────────────────────────────────────────────────────

export const HYPOTHESIS_REGISTRY = [
  {
    name: "baseline",
    description: "Current best strategy, unmodified",
    mutate: (s) => ({ ...s }),
  },
  {
    name: "golomb-order-4",
    description: "Fewer Golomb probes (order 4 = 3 windows) — faster but less density info",
    mutate: (s) => ({ ...s, golombOrder: 4, probeWindowLimit: 100 }),
  },
  {
    name: "golomb-order-7",
    description: "More Golomb probes (order 7 = 6 windows) — better density, more calls",
    mutate: (s) => ({ ...s, golombOrder: 7, probeWindowLimit: 100 }),
  },
  {
    name: "golomb-order-8",
    description: "Maximum Golomb probes (order 8 = 7 windows)",
    mutate: (s) => ({ ...s, golombOrder: 8, probeWindowLimit: 100 }),
  },
  {
    name: "high-concurrency",
    description: "Push concurrency to 20 — faster on high-tier API keys",
    mutate: (s) => ({ ...s, maxConcurrency: 20 }),
  },
  {
    name: "low-concurrency",
    description: "Conservative concurrency 6 — less rate limiting",
    mutate: (s) => ({ ...s, maxConcurrency: 6 }),
  },
  {
    name: "big-budget",
    description: "Double the RPC budget to 80 — better completeness on busy wallets",
    mutate: (s) => ({ ...s, maxRpcCalls: 80, maxRounds: 6 }),
  },
  {
    name: "tight-budget",
    description: "Halve budget to 20 — minimize calls, accept less completeness",
    mutate: (s) => ({ ...s, maxRpcCalls: 20, maxRounds: 2 }),
  },
  {
    name: "large-probe-window",
    description: "Fetch more per probe (300 limit) — fewer rounds needed for medium wallets",
    mutate: (s) => ({ ...s, probeWindowLimit: 300, windowLimit: 300 }),
  },
  {
    name: "no-continuity-oracle",
    description: "Disable continuity oracle — measures how much it actually helps",
    mutate: (s) => ({ ...s, useContinuityOracle: false }),
  },
  {
    name: "no-delta-weighting",
    description: "Uniform gap priority instead of delta-weighted — simpler but may miss hot spots",
    mutate: (s) => ({ ...s, deltaWeightedFill: false }),
  },
  {
    name: "include-zero-delta",
    description: "Don't skip pre===post transactions — complete but noisier",
    mutate: (s) => ({ ...s, skipZeroDelta: false }),
  },
  {
    name: "aggressive-rounds",
    description: "Max refinement rounds (8) with large budget — exhaust the history",
    mutate: (s) => ({ ...s, maxRounds: 8, maxRpcCalls: 60 }),
  },
  {
    name: "one-round-only",
    description: "No refinement — just Golomb probe, rely entirely on continuity oracle",
    mutate: (s) => ({ ...s, maxRounds: 0, maxRpcCalls: 10 }),
  },
  {
    name: "small-windows",
    description: "Target 50 txns/window instead of 80 — less overflow risk",
    mutate: (s) => ({ ...s, targetTxnsPerWindow: 50 }),
  },
  {
    name: "large-windows",
    description: "Target 95 txns/window — fewest windows, more overflow risk",
    mutate: (s) => ({ ...s, targetTxnsPerWindow: 95 }),
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Dynamic hypothesis resolution (used by coordinator and agent child processes)
// ──────────────────────────────────────────────────────────────────────────────

export function resolveDynamicHypothesis(name) {
  // Static registry first
  const static_ = HYPOTHESIS_REGISTRY.find(h => h.name === name);
  if (static_) return static_;

  // gen<G>-<param>-<value>
  const genMatch = name.match(/^gen(\d+)-(golomb|concurrency|budget)-(\d+)$/);
  if (genMatch) {
    const [, , param, valStr] = genMatch;
    const val = parseInt(valStr, 10);
    return {
      name,
      description: `Gen-derived: ${param}=${val}`,
      mutate: (s) => ({
        ...s,
        ...(param === "golomb"      ? { golombOrder: val }      : {}),
        ...(param === "concurrency" ? { maxConcurrency: val }   : {}),
        ...(param === "budget"      ? { maxRpcCalls: val }      : {}),
      }),
    };
  }

  // gen<G>-cross-top2: average top-2 results from previous generation
  const crossMatch = name.match(/^gen(\d+)-cross-top2$/);
  if (crossMatch) {
    return {
      name,
      description: "Crossover of top-2 results from previous generation",
      mutate: (s) => {
        try {
          const files = readdirSync("results").filter(f => f.endsWith(".json"));
          const results = files.map(f => JSON.parse(readFileSync(`results/${f}`, "utf8")));
          const ranked = results.sort((a, b) => (b.aggregate?.score ?? 0) - (a.aggregate?.score ?? 0));
          const t1 = ranked[0]?.strategy ?? {};
          const t2 = ranked[1]?.strategy ?? {};
          return {
            ...s,
            golombOrder:        Math.round(((t1.golombOrder        ?? s.golombOrder)        + (t2.golombOrder        ?? s.golombOrder))        / 2),
            maxConcurrency:     Math.round(((t1.maxConcurrency     ?? s.maxConcurrency)     + (t2.maxConcurrency     ?? s.maxConcurrency))     / 2),
            maxRpcCalls:        Math.round(((t1.maxRpcCalls        ?? s.maxRpcCalls)        + (t2.maxRpcCalls        ?? s.maxRpcCalls))        / 2),
            maxRounds:          Math.round(((t1.maxRounds          ?? s.maxRounds)          + (t2.maxRounds          ?? s.maxRounds))          / 2),
            useContinuityOracle: t1.useContinuityOracle ?? s.useContinuityOracle,
            deltaWeightedFill:   t1.deltaWeightedFill   ?? s.deltaWeightedFill,
          };
        } catch { return s; }
      },
    };
  }

  throw new Error(`Unknown hypothesis: ${name}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Agent runner
// ──────────────────────────────────────────────────────────────────────────────

export async function runAgent(hypothesisName, apiKey) {
  const hypothesis = resolveDynamicHypothesis(hypothesisName);

  // Read current best strategy
  const base = JSON.parse(readFileSync("strategy.json", "utf8"));
  delete base._meta;

  // Apply mutation
  const variant = hypothesis.mutate(base);

  console.log(`[agent:${hypothesisName}] evaluating...`);
  const t0     = performance.now();
  const result = await evaluate(variant, apiKey);
  const wallMs = performance.now() - t0;

  const report = {
    hypothesisName,
    description: hypothesis.description,
    strategy: variant,
    results: result.results,
    aggregate: result.aggregate,
    evalWallMs: wallMs,
    timestamp: new Date().toISOString(),
  };

  mkdirSync("results", { recursive: true });
  writeFileSync(`results/${hypothesisName}.json`, JSON.stringify(report, null, 2));

  console.log(
    `[agent:${hypothesisName}] done  score=${result.aggregate.score.toFixed(3)}` +
    `  avgMs=${result.aggregate.avgLatencyMs.toFixed(0)}` +
    `  rpc=${result.aggregate.totalRpc}` +
    `  complete=${(result.aggregate.completeness * 100).toFixed(0)}%`
  );

  return report;
}

// CLI: node agent.mjs <hypothesis-name> <api-key>
const _isCLI = process.argv[1] && new URL(import.meta.url).pathname === new URL(process.argv[1], 'file://').pathname;
const hypothesisName = _isCLI ? process.argv[2] : null;
const apiKey         = _isCLI ? (process.argv[3] ?? process.env.HELIUS_API_KEY) : null;

if (hypothesisName && apiKey) {
  await runAgent(hypothesisName, apiKey);
}
