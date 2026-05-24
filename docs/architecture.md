# Architecture

How the runtime pieces fit together.

```
                              ┌──────────────────────────────┐
                              │  src/cli/helius-cli.mjs      │
                              │  (profile / sandwich /       │
                              │   follow / watch / cluster)  │
                              └──────────────┬───────────────┘
                                             │ fetchBalanceHistory
                                             ▼
                              ┌──────────────────────────────┐
                              │  src/core/sol_balance_router │
                              │  (tier-detect, density-      │
                              │   classify, route)           │
                              └──────────────┬───────────────┘
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
        ┌───────────────────────────┐               ┌───────────────────────────┐
        │  paid-tier algorithm      │               │  free-tier algorithm      │
        │  3-phase, 2-RTT for       │               │  density-routed BO        │
        │  ≤1000 tx wallets;        │               │  sparse / medium / dense  │
        │  16-band sweep otherwise; │               │  per-class configs from   │
        │  90-sig chunk fetch       │               │  V15 Hybrid trials        │
        └───────────────────────────┘               └───────────────────────────┘
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │  undici HTTP/1.1 pool (64)   │
                              │  → Helius RPC                │
                              └──────────────────────────────┘
```

## Modules

### src/core/sol_balance_router.mjs

The single library entry point. Exports:

* `fetchBalanceHistory(address, apiKey, opts?)` — main API.
* `solPnL(address, apiKey)` — daily-PnL helper.
* `detectApiTier(apiKey)`, `warmup(apiKey)` — utilities.
* `ROUTING_CONFIGS` — frozen per-density config table.

When invoked directly (`node src/core/sol_balance_router.mjs <addr>`), it
prints a developer balance-history table for the address — handy for
sanity-checking the routing logic.

### src/core/sol_pnl.ts

The adaptive parallel balance algorithm written in TypeScript. Used as
reference and for type-checked variants. The runtime .mjs path imports
nothing from this file directly today.

### src/cli/helius-cli.mjs

Subcommand CLI: `profile`, `sandwich`, `follow`, `watch`, `cluster`. It
imports `fetchBalanceHistory` from `../core/sol_balance_router.mjs` and
layers MEV-specific analysis (known-program labelling, sandwich-pattern
detection, co-appearance clustering) on top.

### tools/helius-mcp/helius_mcp_all.mjs

Standalone parallel "fire every Helius MCP tool at once" probe. Useful for
measuring credit cost and per-call latency across all enriched-tx endpoints.

### scout/

The scout line is a separate optimization track — single-purpose fetchers
that bet on fewer requests rather than density routing. The Rust ports
(`sol_balance_scout_rust/`, `sol_balance_v15_rust/`) target the same
algorithm with lower per-request overhead.

### experiments/

The research code that produced the routing configs. Each sub-area
maps to a layer in the experimentation stack:

* `sol_balance/` — algorithm iterations (V1..V15 + codex / hybrid / ultimate)
* `eval/` — scoring harnesses, one per algorithm version
* `research/` — search drivers (Bayesian opt, CMA-ES, DE, hyperband, prime,
  SA, TPE) that feed configs into the matching eval
* `agents/` — earlier multi-agent runners (kept for reference)
* `compare/` — cross-family rollup / leaderboard tooling
* `probes/` — capability detection and exploration scripts

See [experiments.md](experiments.md) for the dependency graph between these
folders.

## Data flow

1. CLI parses the address and a Helius key (env or arg).
2. `fetchBalanceHistory` calls `detectApiTier` to decide paid vs free.
3. **Paid path** runs Phase 0 (3 parallel probes), then Phase 2 (parallel
   90-sig chunked tx fetch). Phase 1 (16-band sig sweep) only runs for
   wallets with > 1000 signatures.
4. **Free path** runs a density probe (`getSignaturesForAddress`,
   limit=1000), classifies sparse/medium/dense, picks the matching
   config from `ROUTING_CONFIGS`, then fetches transactions with that
   config's concurrency and txTarget.
5. Results are normalised to a `{ points, openingLamports, closingLamports }`
   shape and returned to the caller.

## Choosing entry points

* Library consumer → import from `src/core/sol_balance_router.mjs`.
* CLI user → `npm run cli <cmd>` or install globally and use `helius-cli`.
* Research replay → run the matching `experiments/eval/eval_vN.mjs` and
  `experiments/research/research_*.mjs` pair.
