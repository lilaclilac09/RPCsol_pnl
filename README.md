# rpc-sol-pnl-evo

Solana wallet balance, PnL, and MEV analysis toolkit built on top of the Helius
RPC. Includes a CLI for live wallet/MEV investigation, a routing engine that
picks the right fetch strategy per wallet density and API tier, and a research
archive of the V1 → V15 evolution that produced today's defaults.

## Quickstart

```bash
npm install
cp .env.example .env        # then paste your HELIUS_API_KEY
npm run cli profile <wallet_address>
```

`npm run cli` is a thin wrapper around the CLI. Equivalent forms:

```bash
node src/cli/helius-cli.mjs profile <wallet_address>
# or after `npm install -g .`:
helius-cli profile <wallet_address>
```

## CLI commands

```
helius-cli profile  <addr>              Full wallet profile + MEV verdict
helius-cli sandwich <addr>              Find sandwich-attack patterns
helius-cli follow   <addr>              Follow the money (outflows)
helius-cli watch    <addr1> <addr2>...  Live monitor (polls every 4 s)
helius-cli cluster  <addr>              Find co-appearing wallets (bot clusters)
```

## Repository layout

```
src/cli/                 user-facing CLI (helius-cli)
src/core/                routing engine — sol_balance_router, sol_pnl
tools/helius-mcp/        parallel-MCP probe (helius_mcp_all)

scout/                   the "scout" line of work — fast specialized fetchers
  README.md              entry doc
  implementations/       sol_balance_scout, sol_balance_scout_v2/v3,
                         sol_balance_scout_rust/, sol_balance_v15_rust/
  benchmarks/            bench_scout_*, benchmark_scout, final_speed_test
  eval/                  eval_scout_rust
  docs/                  scout-specific deep dives

experiments/             research archive — runners that produced the V1..V15 arc
  agents/                agent.mjs, coordinator.mjs (+ _v2)
  eval/                  eval.mjs … eval_v15, eval_codex, eval_hybrid
  research/              research_bayes/cmaes/de/hybrid/hyperband/prime/sa/tpe
                         and per-version drivers
  sol_balance/           sol_balance.mjs v2..v15 + codex/hybrid/ultimate
  compare/               cross-family leaderboard tooling
  probes/                capability_probe, explore_batch, oliver

examples/                runnable demos: demo_*, scenario_*, sandwich_trace,
                         track_wallets, solrecon, count_txs
tests/                   wallet-level integration tests
scripts/                 setup / launch shell scripts

results/archive/         frozen benchmark outputs (see results/archive/README.md)
docs/                    user-facing docs (quickstart, explain,
                         deployment-checklist, auto-research-methods)
docs/archive/            historical project snapshots + leaderboard.html
                         and mev-dashboard.html

harness/, brain/         evolutionary harness and GBrain integration glue
tools/gbrain/            GBrain submodule
balanced_version/,       additional research artifacts kept for reference
history/, history_v2/,
oliver-course/,
sol-pnl-course/
```

## How the routing engine picks an algorithm

`sol_balance_router.mjs` exposes a single entry point — `fetchBalanceHistory(address, apiKey)` —
that auto-detects the API tier and wallet density, then routes to the algorithm
that won the V1..V15 research arc for that case:

* paid tier — 3-phase, 2-RTT path for wallets up to ~1000 txs; 16-band sweep
  for larger wallets; 90-sig chunk fetch (skips Helius pagination).
* free tier — density classifier (sparse / medium / dense) feeding the BO-optimal
  configuration found in the V15 Hybrid runs (best score 0.0087).

See [docs/explain.md](docs/explain.md) for the full algorithm walkthrough and
[results/archive/README.md](results/archive/README.md) for the per-version evidence.

## Common tasks

| Task                                | Command                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| Profile a wallet                    | `npm run cli profile <addr>`                                  |
| Test the router directly            | `npm run router <addr>`                                       |
| Run integration tests               | `npm test` (uses bun) or `npm run test:node`                  |
| Replay V15 eval                     | `node experiments/eval/eval_v15_stable.mjs <addr>`            |
| Benchmark scout vs router           | `node scout/benchmarks/benchmark_scout.mjs <addr>`            |

## Requirements

* Node 18+ (the `engines` field requires it; `bun` is optional and only used
  by the default `npm test`).
* A Helius API key in `HELIUS_API_KEY`. A second key in `HELIUS_API_KEY_2` is
  only needed for the dual-key scout benchmarks.

## License

MIT.
