# Comprehensive Leaderboard — All Algorithms, All Methods

_Generated 2026-04-13. Scores use the standard metric:_
`score = (completeness × 1000 / avgLatencyMs) × max(0.1, 1 − 0.05 × openGapPenalty)`
_Evaluated on 3 wallets: sparse (4 txns), medium (~60 txns), dense (~286–451 txns)._

---

## All-Time Leaderboard

| Rank | Algorithm | Search Method | Score | Avg Latency | RPC Calls (total) | Key Config |
|------|-----------|---------------|-------|-------------|-------------------|-----------|
| 1 | **V3** (merged anchor-sig) | Bayesian GP-UCB | **~0.72** (stable avg) | ~1460ms | ~22 | anchor=76 window=52 c=23 skip=off |
| 2 | **V4** (hybrid density) | Bayesian GP-UCB | **~0.79** | ~1267ms | ~22 | anchor=92 window=79 c=9 skip=off |
| 3 | V2 (signatures-first) | Bayesian GP-UCB | 0.4585 | 2181ms | ~14 | anchor=85 window=80 c=6 oracle=off |
| 4 | V2 (signatures-first) | CMA-ES | 0.4357 | ~2300ms | ~16 | anchor=55 window=100 c=4 |
| 5 | V2 (signatures-first) | Neighbourhood | 0.4170 | 2400ms | ~16 | anchor=50 window=100 c=16 oracle=on |
| 6 | V1 (Golomb probing) | Neighbourhood | 0.3980 | 2387ms | ~40 | golomb=6 window=300 c=12 |
| 7 | Codex (blockTime density) | Default config | 0.2819 | 3547ms | 127 | windowTarget=80 c=12 |
| 8 | V2 baseline | Default | 0.2740 | 3650ms | ~20 | anchor=100 window=90 c=12 oracle=on |
| 9 | V1 baseline | Default | 0.0780 | 9589ms | ~200 | golomb=6 rounds=4 |

> V3 single-trial best: **0.8790** (1138ms). Stable 3-run average: **0.72** (1530ms). High variance due to Helius free-tier latency jitter.

---

## Algorithm Summaries

### V1 — Golomb Probing
**Design:** Anchor probes at golden-ratio points → density estimation via Golomb ruler → water-fill refinement rounds.  
**Serial round-trips:** 3+  
**Best score:** 0.3980  

### V2 — Signatures-First
**Design:** Dual anchors → enumerate all sig slots (1000/page) → exact-window parallel full fetch.  
**Serial round-trips:** 3 (anchor × 2 + sig pages + full windows)  
**Best score:** 0.4585 (Bayesian)  

### V3 — Merged Anchor-Sig *(new)*
**Design:** `Promise.all([oldest full txns, newest sigs])` fires both in one parallel call.  
For ≤ sigPageSize wallets: sigs arrive in Phase 0, Phase 1 is pure parallel window fetch.  
**Serial round-trips:** **2** (down from 3)  
**Best score:** ~0.72 stable / 0.88 peak  

### V4 — Hybrid Density *(new)*
**Design:** V3's Phase 0 + density-probe fallback for >1000 txn wallets. Eliminates sequential sig pagination by using a single blockTime density probe instead.  
**Serial round-trips:** **2** in ALL cases (including wallets with >1000 txns where V3 falls back to sequential pagination)  
**Best score:** ~0.73 (18/40 BO trials run)  

### Codex Variant — blockTime Windows
**Design:** Parallel newest+oldest anchors → single sig probe → SPARSE exact windows OR DENSE 3-point density estimate.  
**Notable:** Uses blockTime filters instead of slot filters, avoiding Helius slot-filter quirks.  
**Best score:** 0.2819 (default config, unoptimized)  

---

## Per-Method Failure Modes

### V1 (Golomb)
| Failure | Trigger | Impact |
|---------|---------|--------|
| Window overflow | Dense wallet with high txn density in narrow slot range | Extra serial pagination calls; O(N) worst case |
| Refinement thrashing | Many partially-filled windows | Exponential call growth in extreme cases |
| Density misestimate | Sparse wallet suddenly becomes dense | Golomb probes fire in wrong density regime |
| **Root cause** | Density estimation via geometric probing fundamentally approximate | Can't know exact window count before fetching |

### V2 (Signatures-first)
| Failure | Trigger | Impact |
|---------|---------|--------|
| Sequential sig pagination | Wallet with >1000 succeeded txns | 1 extra serial RT per 1000 txns beyond first page |
| High concurrency = slower | Helius rate limit exceeded | 429 retries add 250ms×2^attempt per collision |
| Oracle overhead | useContinuityOracle=true | Extra comparison pass costs more than it saves |
| Anchor size cap | anchorSize > 100 not supported | Must cap at 100; larger anchor values silently truncate |

### V3 (Merged Anchor-Sig)
| Failure | Trigger | Impact |
|---------|---------|--------|
| Helius paginationToken quirk | API returns token even for < sigPageSize results | **Fixed:** treat as truncated only when results == sigPageSize |
| Slot filter gte:0 rejection | oldestLastSlot=−1 (all anchor txns were zero-delta) | **Fixed:** clamp gapFrom to max(1, oldestLastSlot+1) |
| Inverted slot range | gapFrom > maxSlot (anchor covers up to newest sig) | **Fixed:** early-return when gapFrom ≥ maxSlot |
| Large-wallet serial fallback | >1000 txn wallet hits Case 4 | Falls back to sequential sig pagination (V3 weakness) |
| Window size too large | windowSize > 100 | Overflow pagination needed per window |

### V4 (Hybrid Density)
| Failure | Trigger | Impact |
|---------|---------|--------|
| Density underestimate | txns concentrated in short time spans | Too-wide blockTime windows → overflow pagination |
| Density overestimate | txns spread over long time range | Too many tiny windows → rate-limit storm (like Codex on dense wallet) |
| blockTime unavailable | blockTime is null on some txns | Falls back to slot 0 for sorting; ordering may be approximate |
| Extra probe call | Every wallet with >1000 txns | Always 1 extra call (density probe) vs V3 |

### Codex Variant
| Failure | Trigger | Impact |
|---------|---------|--------|
| Over-partitioning on dense wallet | High-density wallet with long time span | 123 calls on dense wallet vs 12 for V3 |
| blockTime null handling | Txns without blockTime | Window may be mis-sized or empty |
| Density estimation overconfident | 3-point estimate is conservative (max of 3 sources) | Consistently fires too many small windows |
| Phase 2 capped at 1 call | > 1000 txn wallet | **Correct design** — but density windows may be too granular |
| No slot-based optimization | Uses blockTime throughout | Extra overhead for blockTime lookups vs slot-based range queries |

---

## Why V3 Beats V2 by ~56%

**The 2-round-trip advantage is decisive:**

```
V2:   [anchor×2] ——serial→ [sig pages] ——serial→ [parallel full windows]
      RT1               RT2                 RT3
      ~800ms            ~400ms              ~1000ms
      Total serial: 3 RTs

V3:   [oldest full + newest sigs] ——parallel——→ [parallel full windows]
      RT1 (both in one)                     RT2
      ~800ms (parallel, not sequential)     ~300ms
      Total serial: 2 RTs
```

For the medium wallet (all txns fit in 1000 sigs): V3 Phase 0 delivers EVERYTHING.
Phase 1 fires 2-3 windows in parallel. Total: 2+3 = 5 calls in 2 serial RTs.

V2 equivalent: 2 anchor calls + 1 sig call + 3 window calls = 6 calls in 3 serial RTs.

---

## Surprising Findings

1. **Optimal concurrency is algorithm-dependent, not API-dependent.**
   - V2 optimal: c=6 (rate-limit retries dominate with 3 serial RTs)
   - V3 optimal: c=23 (2 serial RTs means Phase 1 windows are the bottleneck — more concurrency helps)
   - V4 optimal: c=6 (density windows are fewer but larger, less benefit from concurrency)

2. **skipZeroDelta=false is faster** — the filtering pass costs more than it saves, for all versions.

3. **High-score variance** — V3 scores range 0.47–0.98 in repeated evaluation. Helius free tier has ~2× latency jitter on the sparse wallet (871ms–2970ms). Scores should be treated as distributions, not point estimates.

4. **Codex density approach is correct for very large wallets** — for wallets with >100k txns, the single-probe approach is the only viable strategy. For our test wallets (<500 txns), exact sig enumeration (V3) is faster.

5. **BO outperforms CMA-ES in this parameter space** — BO converges in ~20 trials; CMA-ES needed all 64 evaluations (8 gens × 8 pop) to find comparable configs.

---

## Production Recommendations

### For most use cases (wallets with < 1000 txns)
**Use V3** with BO-optimal config:
```json
{
  "anchorSize": 76,
  "windowSize": 52,
  "sigPageSize": 1000,
  "maxSigPages": 20,
  "maxConcurrency": 23,
  "skipZeroDelta": false
}
```
Expected: ~1.1–1.8s latency, 2–22 RPC calls, 100% completeness.

### For wallets with potentially > 1000 txns
**Use V4** — identical performance to V3 for small wallets; no sequential sig pagination for large wallets:
```json
{
  "anchorSize": 89,
  "windowTarget": 62,
  "windowSize": 62,
  "sigPageSize": 1000,
  "maxConcurrency": 6,
  "skipZeroDelta": false
}
```

### For premium Helius tiers (higher rate limits)
Increase `maxConcurrency` to 24–32. The optimal concurrency scales with the rate limit tier.

### For historical/archival wallets (> 10k txns, precise coverage needed)
Use Codex variant with smaller `windowTarget` (40–60) to balance call count vs precision. The blockTime-based approach avoids slot-filter quirks for very old transactions.

---

## Research Method Comparison

| Method | Trials to Good Solution | Exploration Strategy | Best For |
|--------|------------------------|---------------------|----------|
| Neighbourhood Search | ~40 evals, 3 gen | Grid expansion from winner | Initial parameter exploration |
| Hyperband | ~13 eq-evals, 3 rounds | Multi-fidelity filter | **Not suitable here** — sparse/dense wallets don't correlate |
| CMA-ES | ~64 evals, 8 gen | Covariance adaptation | Correlated parameters (anchor+window) |
| **Bayesian GP-UCB** | **~20 evals** | Uncertainty-aware UCB | **Best overall** — finds novel configs (c=23) quickly |

---

## Files

| File | Contents |
|------|----------|
| `sol_balance.mjs` | V1: Golomb probing |
| `sol_balance_v2.mjs` | V2: Signatures-first (3 serial RTs) |
| `sol_balance_v3.mjs` | V3: Merged anchor-sig (2 serial RTs) |
| `sol_balance_v4.mjs` | V4: Hybrid density (2 serial RTs, all wallet sizes) |
| `sol_balance_codex.mjs` | Codex: blockTime density (single probe) |
| `sol_pnl.ts` | Codex original TypeScript source |
| `eval_v3.mjs` | V3 evaluation harness |
| `eval_v4.mjs` | V4 evaluation harness |
| `eval_codex.mjs` | Codex evaluation harness |
| `research_bayes_v3.mjs` | BO for V3 (4D, 40 trials) |
| `research_bayes_v4.mjs` | BO for V4 (4D, 40 trials) |
| `results_bayes_v3/` | V3 BO logs + best strategy |
| `results_bayes_v4/` | V4 BO logs + best strategy |
| `strategy_v3_best.json` | V3 all-time best config |
| `final_analysis.md` | Previous analysis (V1–V2 + method comparison) |
| `leaderboard_final.md` | **This file** — comprehensive leaderboard |
