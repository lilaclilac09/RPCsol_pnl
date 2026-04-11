# Autoresearch Methods — Selection & Rationale

## Problem Characteristics

| Property | Value |
|---|---|
| Parameter types | Mixed: integers (anchorSize, windowSize, concurrency), booleans (oracle, skipZeroDelta) |
| Parameter count | 5–7 |
| Eval cost | 2–10s per config (3 wallets × wall-clock time) |
| Eval noise | High — Helius API latency varies ±30% between identical runs |
| Objective | Minimise avg latency, maximise completeness |
| Budget | ~50–200 evals total |

---

## Methods Evaluated

### 1. Random Search (current baseline)
**How it works:** Sample random configs from the parameter space; evaluate all;
keep the best. No learning between samples.

**Pros:** Trivial to implement; embarrassingly parallel; surprisingly competitive
vs grid search in high-dimensional spaces (Bergstra & Bengio 2012).

**Cons:** Sample-inefficient; ignores prior observations; doesn't focus search near
promising regions.

**Fit for this problem:** Poor — we have few evals, noisy measurements, and known
structure (score is smooth near good configs). Random search wastes budget.

---

### 2. Hypothesis Neighbourhood Search (what we built)
**How it works:** Start with a static hypothesis registry; run all in parallel;
derive next-gen hypotheses by perturbing the winner's parameters (±step in each
dimension) + crossover of top-2.

**Pros:** Parallelisable; exploits known structure (which params matter); winner's
neighbourhood is explored.

**Cons:** Greedy — only explores winner's neighbourhood, ignores second-best paths.
Crossover of top-2 is heuristic, not principled. Noise can pick wrong winner,
causing the search to branch in the wrong direction.

**Fit:** Good for early exploration; poor for fine-grained convergence.

---

### 3. Bayesian Optimisation — GP-UCB ✅ SELECTED
**How it works:** Maintain a probabilistic surrogate model (Gaussian Process) over
the score landscape. At each step, use the Upper Confidence Bound (UCB) acquisition
function to pick the next point that balances exploration (high uncertainty) and
exploitation (high predicted mean). Update the GP after each eval.

**Equation:**
```
x_next = argmax [ μ(x) + κ·σ(x) ]
```
where μ is the posterior mean, σ is the posterior std dev, κ controls
explore/exploit trade-off (typically 2.0).

**Pros:** Most sample-efficient of all methods; explicitly models uncertainty;
naturally handles noisy evals; provably converges to optimum.

**Cons:** GP inference is O(n³) — slow past ~500 observations (not an issue here).
Requires encoding categorical/boolean params. Tuning the kernel matters.

**Fit for this problem:** **Excellent.** Small eval budget (50–200 runs), noisy
measurements, smooth score landscape — exactly the GP-BO sweet spot.

**Implementation plan:** RBF kernel GP with ARD (Automatic Relevance Determination)
per param. Encode booleans as {0,1}. Integers rounded after suggestion. UCB
acquisition with κ=2.0. No external dependencies — pure JS math.

---

### 4. Hyperband (Successive Halving) ✅ SELECTED
**How it works:** Inspired by bandit theory. Start with N random configs evaluated
at low fidelity (1 wallet instead of 3, or shorter timeout). Keep the top 1/η
fraction, double their budget, repeat until 1 config remains evaluated at full
fidelity.

**Bracket structure (η=3):**
```
Round 1: 27 configs × 1 wallet  → keep top 9
Round 2:  9 configs × 2 wallets → keep top 3
Round 3:  3 configs × 3 wallets → keep top 1 (winner)
```

**Pros:** Handles noisy evals — cheap configs are discarded early, expensive
full-eval budget goes to configs that already proved promising. Natural multi-fidelity.

**Cons:** Assumes performance at low fidelity correlates with full fidelity (usually
true). Requires generating many random initial configs.

**Fit for this problem:** **Excellent.** Sparse and medium wallets are fast (2 calls);
dense wallet is the bottleneck. Hyperband can filter on sparse+medium first and only
run dense evaluation on the survivors.

---

### 5. CMA-ES (Covariance Matrix Adaptation Evolution Strategy) ✅ SELECTED
**How it works:** Maintains a multivariate Gaussian distribution over the parameter
space. Each generation samples λ candidates, evaluates them, then updates the mean
and covariance matrix to move toward better regions. The covariance captures
parameter correlations (e.g. "high concurrency + small windows both help").

**Update rule:**
```
mean ← weighted sum of top-μ candidates
C    ← updated covariance from step directions
σ    ← step size adapted via path length control
```

**Pros:** Handles parameter correlations natively; adapts step size automatically;
fast convergence on unimodal landscapes; doesn't need gradient.

**Cons:** Needs ~10×dim evaluations to warm up the covariance (70 evals for 7 params).
Designed for continuous params — need rounding for integers.

**Fit for this problem:** **Good.** Continuous param space (concurrency, windowSize,
anchorSize are all continuous-ish integers). Will discover e.g. the joint
(anchorSize=50, windowSize=100, concurrency=16) optimum faster than neighbourhood
search.

---

### Methods NOT Selected

| Method | Reason skipped |
|---|---|
| Grid search | Exponential in param count; 7 params × 5 values = 78125 configs |
| Simulated annealing | Sequential by design — can't parallelise; slower than BO |
| Population-based training (PBT) | Requires continuous training process; evals are one-shot |
| SMAC (random forest surrogate) | Better for discrete/categorical; overkill complexity |
| Reinforcement learning | Requires much larger eval budget (thousands of episodes) |
| Gradient-based (Adam, SGD) | Score function not differentiable |

---

## Execution Plan

Each method runs against **V2** (the current best algorithm), using the same 3 test
wallets and scoring function from `eval_v2.mjs`.

| Method | File | Evals | Parallelism |
|---|---|---|---|
| Bayesian Opt (GP-UCB) | `research_bayes.mjs` | 40 sequential | 1 at a time (GP requires sequential updates) |
| Hyperband | `research_hyperband.mjs` | ~27 total | 4 parallel within each round |
| CMA-ES | `research_cmaes.mjs` | 60 total (6 gens × 10) | 4 parallel per generation |

After all 3 methods complete, results are merged into a single leaderboard and the
best config found by any method is written to `strategy_v2_best.json`.
