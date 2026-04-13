# Final Analysis — RPCsol_pnl Research Dashboard

**Last updated: 2026-04-13 | V1–V15 complete**

---

## Summary Table — All Versions

| Version | API | Solver | Best Score | Avg Latency | Method | Key Config |
|---------|-----|--------|-----------|-------------|--------|------------|
| V1 | Paid | Golomb probing | 0.398 | ~3500ms | Neighbourhood | golomb=6 window=300 c=12 |
| V2 | Paid | Signatures-first | 0.620 | ~2300ms | Diff. Evolution | anchor=80 window=70 c=6 oracle=on |
| V3 | Paid | Merged anchor-sig | 0.879¹ | 1138ms | Bayesian GP-UCB | anchor=76 window=52 c=23 skip=off |
| V4 | Paid | Hybrid density | 0.573² | 1756ms | PRIME | anchor=65 window=86 c=14 skip=off |
| V8 | Paid | Streaming pipeline | 0.556 | 1799ms | Bayesian GP-UCB | anchor=18 window=98 c=17 skip=on |
| V10 | Paid | Ultra low-latency | 0.690 | 1450ms | Bayesian GP-UCB | anchor=100 window=83 c=19 skip=on |
| V11 | Paid | Hybrid+Ultra | 0.663 | 1509ms | Bayesian GP-UCB | window=71 target=114 c=17 skip=on |
| V12S | Paid | Score-Max | 0.744 | 1344ms | Bayesian GP-UCB 4D | window=105 c=23 skip=off |
| V12L | Paid | Latency-Min | 0.532 | 1881ms | Bayesian GP-UCB (bottleneck) | window=63 c=22 skip=off |
| V13 | Paid | Constrained BO | **0.789** | **1267ms** | Bayesian GP-UCB 60-trial | window=91 c=31 skip=on |
| V14 | Paid | Phantom-token fix | TBD | est. <1000ms | GP-UCB pending | phantom-fix applied |
| V15 | **Free** | getSignaturesForAddr | ~0.009 | ~3800ms | Bayesian GP-UCB 3D | txTarget=31 c=12 skip=off |

¹ V3 single-trial score 0.879 was not stable — 3-run stable average = 0.7156.  
² V4 = best stable mean from unified 6-repeat benchmark run.  
All V8–V15 measured on a different API key with ~180ms higher baseline RTT than V3/V4.

---

## Key Technical Findings

### 1. V3 0.879 Was a Lucky Run (Not Architecture)

The V3 single-trial score of 0.879 appeared to be a breakthrough. Investigation showed:
- Score formula: `1000 / avgLatencyMs`. V3's 0.879 = `1000 / 1138ms`.
- Old API key had ~180ms lower RTT baseline than new key.
- On new key: equivalent estimated score = ~0.747 (matches V12S's 0.744 exactly).
- Confirmed: V3 3-run stable average = **0.7156** at 1530ms (from strategy_v3_best.json).
- V3 was NOT architecturally better than V12S — it just had a faster endpoint.

**Why c=23 was V3's optimum:** Dense wallet (451 txns) with window=52 creates 9 slot windows. With the phantom token bug (see §3), each window made 2 API calls = 18 parallel calls. c≥18 needed to saturate; c=23 leaves buffer. Above c=24, rate limiting triggers.

### 2. Dense Wallet Dominates Total Latency

Dense wallet (59tGCiHi…1P8n, ~451 SOL transactions) = **77.3% of total wall time** in V12S:
- sparse: 314ms (7.8%)
- medium: 602ms (14.9%)
- dense: 3117ms (77.3%)

Improving dense is the primary lever for score improvement. This drove the V13 constrained BO to optimize specifically for dense wallet latency.

### 3. Phantom PaginationToken Bug (V11–V13, Fixed in V14)

**Root cause:** Helius `getTransactionsForAddress` returns `paginationToken` even when `data.length < limit` (e.g., 80 results returned with a limit of 100 still includes a token). The `fetchSlotWindow` while-loop followed this phantom token, making one extra API call per window that returned 0 results.

**Impact:** Dense wallet (6 real windows at window=91): 6 calls → 12–16 calls (2×–3× inflation). Wall time: ~700ms → ~3000ms. Prevented V11/V12/V13 from achieving gate=1.0.

**V14 fix:**
```javascript
if (data.length < LIMIT) return samples;  // skip phantom token
```

**Expected V14 impact:** Dense wallet 14 calls → 6–8 calls, 2951ms → ~700ms. All 3 wallets under 2s. Score jump from 0.789 → estimated 1.5–2.0.

### 4. Optimal Window Size for Dense Wallet

After phantom-token fix, window size analysis:
- window=95: ceil(451/95)=5 windows, ~91 txns each (<100 limit), 7 total calls
- window=80: 6 windows, ~76 txns each, 8 total calls
- window>113: 4 windows but >100 txns each → REAL pagination required again

Sweet spot: window=90–100 → 5–6 windows, never overflows 100-txn limit → no real pagination needed after phantom fix.

### 5. V15 Free-Tier Analysis

**Trigger:** Helius paid API key expired. V15 switches to standard Solana RPC.

**Architecture change:**
- Paid: `getTransactionsForAddress` (filters: status=succeeded, tokenAccounts=none)
- Free: `getSignaturesForAddress` + individual `getTransaction` calls

**Free-tier constraints:**
- Rate limit: ~10 RPS
- Batch JSON-RPC: blocked (403: "Batch requests only for paid plans")
- No pre-filtering of SOL-changing transactions

**Gate penalty math (the critical insight):**
```
txTarget=120 → 12s/wallet → gate=0.05 → score≈0.005 (full completeness)
txTarget=20  → 3s/wallet  → gate=0.05 → score≈0.006 (sparse only)
txTarget=10  → 1.5s/wallet → gate=1.0 → score≈0.222 (sparse only) ← 37× better
```
Theory predicted gate=1.0 at txTarget=10–12 would score 37× better. Reality: under sustained API load, effective call rate degrades to ~1.8 calls/sec (vs theoretical 10 RPS), making even 12 calls take 6.8s. Gate=1.0 is unachievable under sustained load.

**Actual optimal (discovered by BO):**
- txTarget=31, c=12, skipZeroDelta=false → score=0.0087 (best observed)
- **Key mechanism:** `skipZeroDelta=false` counts ALL fetched transactions as samples (every getSignaturesForAddress result includes the target address in accountKeys). Medium wallet (need 30 samples) becomes complete at txTarget=30.
- Completeness: 2/3 (sparse + medium complete, dense needs 100 samples = txTarget=100+, too slow)

**V15 vs V13 comparison:**
- V13 (paid): score=0.789, avg=1267ms, ~18 RPC calls
- V15 (free): score=0.009, avg=3800ms, ~80 RPC calls
- Free-tier is **88× worse** in score, **3× slower**, **4× more calls**

---

## Search Method Comparison

| Method | Algorithm | Best Score | Evals | Verdict |
|--------|-----------|-----------|-------|---------|
| Bayesian GP-UCB | V3 | 0.879¹ (trial 19) | 19 | Best for V3/V4 — discovers c=23 fast |
| Bayesian GP-UCB | V13 | 0.789 (trial 2!) | 2 | Lucky fast convergence on constrained BO |
| Bayesian GP-UCB | V12S | 0.744 (trial 11) | 11 | Standard 4D search |
| Differential Evolution | V2 | 0.620 (gen 1) | ~8 | Surprising — best V2 result in fewest evals |
| TPE (Parzen) | V2 | 0.614 (trial 12) | 12 | Competitive; simpler than BO |
| CMA-ES | V2 | 0.436 (gen 2) | ~24 | Found c=4 tradeoff; missed oracle=true |
| Neighbourhood Search | V2 | 0.417 (gen 3) | ~40 | Local optima trap |
| Hyperband | V2 | 0.321 | 13 eq | Failed — sparse wallet doesn't discriminate |
| Bayesian GP-UCB | V15 (free) | ~0.009 | 50 | Optimizes within free-tier constraints |

---

## Production Recommendations

### Paid API (when available)
**V4 — all wallet sizes:** `anchorSize=92, windowSize=79, maxConcurrency=9, skipZeroDelta=false`  
**V13 — known small wallets:** `windowSize=91, maxConcurrency=31, skipZeroDelta=true`  
**V14 — after key renewal:** expected score ~1.5–2.0 with phantom-token fix

### Free API (fallback)
**V15 — when paid key unavailable:**
```javascript
{ sigPageSize: 1000, maxSigPages: 6, txTarget: 31, maxConcurrency: 12, skipZeroDelta: false }
```
Expect: sparse ~2s, medium ~3.5s, dense ~6s. Score ~0.009 (100× worse than paid tier).

---

## Versions Pending

- **V14 BO run:** Paid API key renewal required. Expected to achieve gate=1.0 (all wallets <2s) after phantom-token fix. Estimated score 1.5–2.0.
- **CMA-ES re-run:** `research_cmaes.mjs` is running on V2 solver — historical comparison only.
