# V2 Analysis — Signatures-First Algorithm

## Core Idea

Phase 0 fetches newest 100 + oldest 100 full transactions in parallel (anchor).
If they overlap, done. Otherwise Phase 1 uses the cheap signatures endpoint
(1000 sigs/call) to enumerate every transaction slot in the gap. Phase 2 bins
those exact slot positions into windows and fires all full-transaction fetches in
parallel. Windows are sized from real sig positions — they never overflow.

## Unique Features

### Exact Window Sizing from Signatures
The signatures endpoint returns slot numbers for up to 1000 transactions per call.
Because V2 knows exactly where every transaction sits before committing to full
fetches, Phase 2 windows are perfectly sized. No window ever returns a `paginationToken`
during normal operation — one API call per window, guaranteed.

### 10× Cheaper Discovery Pass
Full transaction calls are capped at 100 txns per call. Signature calls return up
to 1000 per call. For a 451-txn wallet, V1 needs ~5 Golomb probe calls (each
fetching up to 100 full txns per page). V2 needs 1 signature call to learn all 451
positions. Discovery is 10× cheaper per transaction.

### Zero Refinement Rounds
Because window positions come from real data, there is no estimation, no overflow,
and no refinement loop. The algorithm is strictly 3 sequential phases: anchor →
sig scan → parallel fetch. Complexity is `O(1)` in rounds rather than `O(maxRounds)`.

### Predictable Call Count Formula
For any wallet with `N` transactions in the gap:
```
total_calls = 2                          (anchor)
            + ceil(N / sigPageSize)      (Phase 1 sig pages)
            + ceil(N / windowSize)       (Phase 2 full fetches)
```
For `N=451`, `sigPageSize=1000`, `windowSize=100`:
`2 + 1 + 5 = 8 calls` — predictable, no surprises from density estimation errors.

### Continuity Oracle at Anchor Level
If `oldest.postLamports === newest.preLamports` after Phase 0, the entire gap is
flat. This check happens before any Phase 1/2 work — zero extra calls for wallets
that received no net SOL change in the middle of their history.

---

## Obstacles Encountered

### Helius Full-Tx Limit of 100 Per Call
`anchorSize=200` or `anchorSize=300` appeared to work but silently returned only
100 txns with a `paginationToken`. The original anchor loop then fetched a second
empty page to "confirm" (2 calls per anchor instead of 1). Sparse wallets ballooned
from 2 calls to 4. **Fix:** hard-cap anchor at `Math.min(anchorSize, 100)` and use
one call per anchor direction.

### Sequential Phase Dependency Adds Latency
Phase 1 must finish before Phase 2 can start (need sig positions before sizing
windows). This creates two unavoidable serial round-trips (anchor → sig) even if
Phase 2 is fully parallel. V1's Golomb probes run as a single parallel blast after
anchors — no such dependency.

### `paginationToken` Spurious on Small Wallets (inherited from V1)
Same bug: Helius returns a non-null token for the sparse 4-txn wallet even though
all 4 transactions fit in the first anchor page. **Fix:** overlap condition
(`oldestLastSlot >= newestFirstSlot`) rather than `!paginationToken`.

### Large Wallets Require Sequential Sig Pagination
Wallets with >1000 gap transactions need multiple signature pages. V2 fetches these
sequentially (each page depends on `paginationToken` from the previous). A 5000-txn
wallet needs 5 sequential sig calls before Phase 2 can begin.

---

## What Can Be Enhanced

| Area | Current | Enhancement |
|---|---|---|
| Sig pagination | Sequential — each page waits for previous `paginationToken` | Slot-range partitioning: fire parallel sig calls across estimated sub-ranges (density-guided) |
| Anchor + sig overlap | Two sequential phases | Combine: anchor fetches carry sig data too (use `transactionDetails: "signatures"` for one large anchor scan) |
| Phase 2 window grouping | Simple linear bins of `windowSize` sigs | Slot-aware grouping: cluster sigs by temporal proximity, avoid windows straddling large slot gaps |
| Empty-gap detection | Only at anchor level via continuity oracle | After sig scan, detect sub-ranges with zero sigs — skip Phase 2 fetch for those ranges entirely |
| Adaptive window size | Fixed `windowSize` per run | Tune window size based on observed sig density: sparse clusters → larger windows; dense clusters → 100 exactly |
| Retry granularity | Retries whole Phase 2 window on failure | Log per-window failure; retry only failed windows rather than the full scan |

---

## Autoresearch Findings (3 Generations, Parallel Agents)

Gen 1 winner: `anchor-50-window-100-c16` — smaller anchors (50), full-page windows
(100 = Helius full-tx max), higher concurrency (16). Score 0.381, 2.6s avg.

Gen 2 winner: `baseline` running on the updated strategy — confirmed `anchor-50`,
`windowSize=100`, `concurrency=16` combination. Score 0.417, 2.4s avg. Best of all
time across both algorithms.

Gen 3: no improvement — algorithm converged on the Gen 2 config.

**Key convergence:** smaller anchor (50 vs 100) is faster because the 4-txn sparse
wallet still fast-exits (50 > 4), and the anchor calls return faster with fewer
results. `windowSize=100` = single-page windows (no internal pagination needed).
`concurrency=16` balances throughput vs rate-limit collisions.

**All-time best config:**
```json
{
  "anchorSize": 50,
  "sigPageSize": 1000,
  "windowSize": 100,
  "maxSigPages": 20,
  "maxConcurrency": 16,
  "useContinuityOracle": true,
  "skipZeroDelta": true
}
```
Score: **0.417** | Avg latency: **2.4s** | Total calls: **14** (vs V1's 18)

---

## V1 vs V2 Head-to-Head

| Metric | V1 winner | V2 winner | Winner |
|---|---|---|---|
| Score | 0.398 | 0.417 | **V2 +5%** |
| Avg latency | 2.4s | 2.4s | Tie |
| Dense wallet calls | 18 | 14 | **V2 −22%** |
| Overflow risk | Medium (density estimate) | None (exact positions) | **V2** |
| Serial round-trips | 2 (anchor + Golomb parallel) | 3 (anchor + sig + fetch) | **V1** |
| Large wallet (>1000 txn) | Hits budget, leaves gaps | Sequential sig pages | Both degrade |
| Code complexity | High (oracle + water-fill + rounds) | Low (3 fixed phases) | **V2** |
