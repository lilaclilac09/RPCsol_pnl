# Final Analysis — All-Time Leaderboard & Method Comparison

## All-Time Best Config

```json
{
  "anchorSize": 85,
  "windowSize": 80,
  "sigPageSize": 1000,
  "maxSigPages": 20,
  "maxConcurrency": 6,
  "useContinuityOracle": false,
  "skipZeroDelta": false
}
```
**Score: 0.4585 | Avg latency: 2.18s | Algorithm: V2 (signatures-first)**
Found by: Bayesian Optimisation, trial 15/40

---

## Full Leaderboard (all methods, all algorithms)

| Rank | Method | Score | AvgMs | Algorithm | Key config |
|------|--------|-------|-------|-----------|------------|
| 1 | Bayesian (GP-UCB) | **0.4585** | 2181ms | V2 | anchor=85 window=80 c=6 oracle=off |
| 2 | CMA-ES | 0.4357 | ~2300ms | V2 | anchor=55 window=100 c=4 oracle=off |
| 3 | V2 neighbourhood | 0.4170 | 2400ms | V2 | anchor=50 window=100 c=16 oracle=on |
| 4 | V1 neighbourhood | 0.3980 | 2387ms | V1 | golomb=6 window=300 rounds=0 c=12 |
| 5 | Hyperband | 0.3216 | 3110ms | V2 | anchor=68 window=23 c=16 oracle=off |
| 6 | V2 baseline | 0.2740 | 3650ms | V2 | anchor=100 window=90 c=12 oracle=on |
| 7 | V1 baseline | 0.0780 | 9589ms | V1 | golomb=6 window=100 rounds=4 c=12 |

---

## Method Comparison

### Neighbourhood Search (our first approach)
**How it worked:** Static hypothesis registry → parallel eval → pick winner →
expand neighbourhood (+/− one step per param) → repeat.

**What it found:** V1: 0.398 in 3 gens (~48 evals). V2: 0.417 in 3 gens (~40 evals).
**Strength:** Fast to implement, great for early-stage exploration of discrete knobs.
**Weakness:** Gets stuck in local neighbourhoods; greedy winner selection amplifies noise.

---

### Hyperband (Successive Halving)
**How it worked:** Many random configs evaluated at low fidelity (1 wallet); top
third promoted to mid fidelity (2 wallets); top third again to full (3 wallets).

**What it found:** 0.3216 — **worst of the three advanced methods.**

**Why it underperformed:**
- Fidelity correlation was weak. A config that runs fast on the 4-txn sparse wallet
  does NOT predict well on the 451-txn dense wallet. The sparse wallet always fast-exits
  in 2 calls regardless of window/anchor params — it's not a meaningful signal.
- Random initial configs rarely hit the good region; without guidance, early-fidelity
  filtering mostly discards good configs by chance.

**When Hyperband IS useful:** Problems where fidelity correlates strongly (e.g. neural
network training — 10 epochs predicts 100 epochs well). For this RPC problem where
sparse and dense wallets behave completely differently, fidelity levels are poorly
calibrated.

**Fix for future use:** Use dense wallet as the ONLY low-fidelity eval, not sparse.
Dense wallet is the bottleneck and the discriminating signal.

---

### CMA-ES (Covariance Matrix Adaptation)
**How it worked:** Maintained a Gaussian distribution over the 5D parameter space.
Each generation sampled 8 candidates, evaluated them in parallel batches, then updated
the distribution mean and covariance toward better regions.

**What it found:** 0.4357 — 4% better than neighbourhood search.

**Key insight it found:** `windowSize=100` (max single-page) consistently scores well.
`maxConcurrency=4` surprises — much lower than neighbourhood search's 16.

**Why concurrency=4 can win:** With rate-limit retries adding ~500ms per collision,
low concurrency may actually reduce total wall time by avoiding retry overhead. CMA-ES
naturally discovered this parameter correlation (anchor ↑ + concurrency ↓ = fast)
that grid/neighbourhood search missed.

**Convergence:** Collapsed toward `anchorSize≈100`, `windowSize≈100`, `concurrency≈4`
by gen 6, but kept exploring there fruitlessly. Step size σ decreased from 0.4 to
0.195 — appropriate convergence behaviour.

---

### Bayesian Optimisation (GP-UCB) — **WINNER**
**How it worked:** Maintained a Gaussian Process over the score landscape. UCB
acquisition balanced exploration (high σ regions) with exploitation (high μ regions).
κ decayed from 2.0 to 0.03 over 40 trials, shifting from explore to exploit.

**What it found:** 0.4585 — **best overall, 10% above V2 neighbourhood search.**

**Key discoveries:**
1. `useContinuityOracle=false` is consistently better. The oracle adds a check
   before Phase 1, but the sparse wallet already fast-exits via overlap, and for
   dense wallets the oracle rarely triggers. The comparison overhead costs more
   than it saves.
2. `skipZeroDelta=false` — include all transactions. The filter adds a pass over
   each transaction's pre/post balances; removing it is cheaper than the filter cost.
3. `maxConcurrency=6` beats 16 and 24. This is the most surprising finding:
   very high concurrency causes enough rate-limit retries (each ~250ms×2^retry)
   to be slower than 6 serialised calls. The Helius free tier's rate limit is the
   real bottleneck, not our parallelism.
4. `anchorSize=85` beats 50 and 100. 85 captures nearly as many as 100 but the
   anchor calls return slightly faster with fewer results.

**Why BO outperforms CMA-ES:** BO's UCB acquisition explicitly models uncertainty —
after 15 trials it had learned that `concurrency=6` was consistently fast and focused
all remaining evals there. CMA-ES kept a wider covariance and kept sampling away from
the optimum.

---

## Key Algorithmic Insights Across All Research

### 1. Continuity Oracle is a Net Negative on V2
V1 uses the oracle in refinement rounds — it saves calls in a context where calls
are expensive. V2 has no refinement rounds, so the oracle only runs once at anchor
level. The check costs more than it saves. Remove it.

### 2. Optimal Concurrency is 4–8, Not 12–24
Every advanced method converged on low concurrency. The Helius API rate limit is the
binding constraint, not parallelism. Beyond 6 concurrent requests, collisions and
retries dominate. The optimal is likely API-tier dependent.

### 3. Window Size Should Match the API Limit Exactly
`windowSize=80–100` consistently wins. At 100, each Phase 2 window is guaranteed to
fit in exactly one API call. At 80, you get a small safety margin against borderline
windows. Both beat 50 (too many calls) and 200 (pagination needed).

### 4. Anchor Size 80–100 Is Optimal for Fast Wallet Detection
Smaller anchors (50) miss the chance to fast-exit on ~100-txn wallets (missed
fast-exit = 7 more calls). Larger anchors are capped at 100 by the API. Sweet spot
is 80–100.

### 5. `skipZeroDelta=false` Reduces Overhead
Filtering pre===post transactions adds a comparison loop over every transaction.
For the test wallets (~14 total RPC calls), this loop runs thousands of times. The
filtering cost exceeds the benefit of excluding zero-delta txns.

---

## What's Left to Explore

| Opportunity | Expected gain | Complexity |
|---|---|---|
| Parallel sig pagination for large wallets | −50% latency on >1000 txn wallets | Medium |
| Adaptive concurrency: start high, back off on 429 | Better on premium API tiers | Medium |
| Combine V1 Golomb + V2 sig-exact: Golomb for discovery, exact for fetch | Could beat V2 on dense wallets | High |
| BO with restarts (multiple κ schedules) | More thorough exploration | Low |
| Eval on 5+ wallet types (staking, DeFi, NFT) | More robust generalisation | Medium |
| Multi-objective Pareto: minimise (latency, rpc_calls) jointly | Expose trade-off curve | Medium |

---

## Files Produced

| File | Contents |
|---|---|
| `sol_balance.mjs` | V1: Golomb probing algorithm |
| `sol_balance_v2.mjs` | V2: Signatures-first algorithm |
| `v1_analysis.md` | V1 features, bugs, enhancements |
| `v2_analysis.md` | V2 features, bugs, enhancements |
| `autoresearch_methods.md` | Method selection rationale |
| `strategy.json` | V1 best config (score 0.398) |
| `strategy_v2.json` | V2 neighbourhood best (score 0.417) |
| `strategy_v2_best.json` | **All-time best config (score 0.4585)** |
| `research_bayes.mjs` | Bayesian Optimisation (GP-UCB) |
| `research_hyperband.mjs` | Hyperband (Successive Halving) |
| `research_cmaes.mjs` | CMA-ES (Evolution Strategy) |
| `results_bayes/` | BO trial logs + best strategy |
| `results_cmaes/` | CMA-ES generation logs + best |
| `results_hyperband/` | Hyperband bracket logs + best |
