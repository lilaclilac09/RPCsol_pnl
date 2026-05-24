# results/archive

Frozen benchmark and experiment outputs from the V1 → V15 research arc.

Each subdirectory matches the experiment family that produced it:

  v1, v2 … v15            per-version balance-history runs
  bayes, bayes_v3 … v11   Bayesian-optimization sweeps
  bayes_codex             Bayesian sweep with the Codex eval harness
  cmaes                   CMA-ES sweep
  codex                   Codex-aggregated results
  de                      Differential evolution
  hybrid                  Hybrid eval (paid + free tier mix)
  hyperband               Hyperband bandit allocation
  prime_v3, prime_v4      "Prime" tuning runs
  sa                      Simulated annealing
  tpe                     Tree-structured Parzen Estimator
  unified                 Unified leaderboard rollups (eval families merged)
  v12_latency             V12 latency-focused score
  v12_score               V12 throughput-focused score
  strategies/             Winning strategy.json snapshots per version

These are kept for reproducibility. The runners that produced them live under
[experiments/research/](../../experiments/research/), and the eval harnesses
under [experiments/eval/](../../experiments/eval/).
