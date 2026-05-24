# Experiments

The research arc that produced today's routing configs lives under
[experiments/](../experiments/). This page is a map of what's there and
how the pieces depend on each other.

## How the pieces relate

```
research_*.mjs   ──drives──▶   eval_*.mjs   ──scores──▶   sol_balance_*.mjs
       (search)                   (harness)                  (algorithm)
```

* `sol_balance_*.mjs` is a candidate algorithm.
* `eval_*.mjs` runs that algorithm against the test set and produces a score.
* `research_*.mjs` searches a config space, calling `eval_*.mjs` repeatedly,
  and writes the best config + log to `results/archive/<family>/`.

## Algorithm versions

| File (`experiments/sol_balance/`)        | Eval pair (`experiments/eval/`)            | Notes                                       |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| `sol_balance.mjs`                        | `eval.mjs`                                 | V1 baseline                                 |
| `sol_balance_v2.mjs`                     | `eval_v2.mjs`                              | V2 — used by bayes/sa/tpe/de/hyperband     |
| `sol_balance_v3.mjs`                     | `eval_v3.mjs`                              | V3 — used by bayes_v3 / prime_v3           |
| `sol_balance_v4.mjs`                     | `eval_v4.mjs`                              | V4 — used by bayes_v4 / prime_v4           |
| `sol_balance_v8.mjs`                     | `eval_v8.mjs`                              | V8 — bayes_v8                              |
| `sol_balance_v9.mjs`                     | (re-uses V8 eval via import)              | minor V8 variant                            |
| `sol_balance_v10.mjs`                    | `eval_v10.mjs`                             | V10 — bayes_v10                            |
| `sol_balance_v11.mjs`                    | `eval_v11.mjs`, `eval_v12_latency.mjs`,    | V11 solver, also driven by V12 score evals |
|                                          | `eval_v12_score.mjs`, `eval_v13.mjs`       |                                             |
| `sol_balance_v12.mjs`                    | (orchestration via v11 evals)              |                                             |
| `sol_balance_v14.mjs`                    | `eval_v14.mjs`                             | V14                                         |
| `sol_balance_v15.mjs`                    | `eval_v15.mjs`, `eval_v15_stable.mjs`     | V15 — best score 0.0087                    |
| `sol_balance_codex.mjs`                  | `eval_codex.mjs`                           | Codex variant                               |
| `sol_balance_hybrid.mjs`                 | `eval_hybrid.mjs`                          | Free-tier hybrid; imports V14 solver        |
| `sol_balance_ultimate.mjs`               | n/a                                        | superseded by the router                    |

## Search families

| Driver (`experiments/research/`) | Eval used                 | Output (`results/archive/`) |
| -------------------------------- | ------------------------- | --------------------------- |
| `research_bayes.mjs`             | `eval_v2.mjs`             | `bayes/`                    |
| `research_bayes_v3/v4/v8/v10/v11.mjs` | matching `eval_vN.mjs` | `bayes_v3..v11/`            |
| `research_bayes_codex.mjs`       | `eval_codex.mjs`          | `bayes_codex/`              |
| `research_cmaes.mjs`             | `eval_v2.mjs`             | `cmaes/`                    |
| `research_de.mjs`                | `eval_v2.mjs`             | `de/`                       |
| `research_sa.mjs`                | `eval_v2.mjs`             | `sa/`                       |
| `research_tpe.mjs`               | `eval_v2.mjs`             | `tpe/`                      |
| `research_hyperband.mjs`         | runs against `sol_balance_v2.mjs` directly | `hyperband/` |
| `research_prime_v3.mjs`          | `eval_v3.mjs`             | `prime_v3/`                 |
| `research_prime_v4.mjs`          | `eval_v4.mjs`             | `prime_v4/`                 |
| `research_hybrid.mjs`            | uses `sol_balance_hybrid.mjs` directly | `hybrid/`              |
| `research_v12_latency.mjs`       | `eval_v12_latency.mjs`    | `v12_latency/`              |
| `research_v12_score.mjs`         | `eval_v12_score.mjs`      | `v12_score/`                |
| `research_v13/v14/v15.mjs`       | matching `eval_vN`/stable | `v13/`, `v14/`, `v15/`      |

## Cross-family tools

* `experiments/compare/compare_unified_leaderboard.mjs` — pulls scores from
  all eval families and produces a unified leaderboard. Output:
  `results/archive/unified/`.
* `experiments/compare/compare_codex_methods.mjs` — pairwise comparison of
  codex variants.
* `experiments/compare/aggregate_codex_results.mjs` — rollup helper for the
  codex family.

## Probes

* `experiments/probes/capability_probe.mjs` — detects which Helius features
  the supplied API key has access to (paid/enhanced/standard).
* `experiments/probes/explore_batch.mjs` — exercises batch RPC patterns;
  imports `oliver.mjs` for shared HTTP primitives.
* `experiments/probes/oliver.mjs` — extracted set of low-latency primitives
  (semaphore, retry, timed) reused across probes.

## Replaying a single run

```bash
# Score V15 against the test wallets:
node experiments/eval/eval_v15_stable.mjs

# Re-run the Bayesian search that produced V15:
node experiments/research/research_v15.mjs

# Build the cross-family leaderboard from existing results:
node experiments/compare/compare_unified_leaderboard.mjs
```

All commands assume `HELIUS_API_KEY` is set (see `.env.example`).
