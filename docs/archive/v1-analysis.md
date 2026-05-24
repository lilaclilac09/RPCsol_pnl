# V1 Analysis — Golomb Probing Algorithm

## Core Idea

Phase 0 fetches the newest 100 + oldest 100 full transactions in parallel to bound
the wallet's activity range `[minSlot, maxSlot]`. Phase 1 fires 5 Golomb-ruler probe
windows across that exact range simultaneously. Phase 2 runs iterative refinement
rounds to fill remaining gaps, guided by the continuity oracle and delta-weighted
water-filling.

## Unique Features

### Golomb-Ruler Window Placement
Uses perfect Golomb rulers (e.g. order-6: marks `[0,1,4,10,12,17]`) to space probe
windows. Every pairwise distance between marks is unique, which means the 5 windows
sample the wallet's history at multiple scales simultaneously without aliasing. A
uniform split would only sample at one scale; Golomb detects both fine-grained
clusters and long sparse gaps in the same pass.

### Balance-Continuity Oracle
If the last transaction in window A has `postLamports === preLamports` of the first
transaction in window B, the gap between them is provably flat — no SOL-changing
transactions exist there. This prunes gaps in zero extra API calls. On periodic
wallets (regular fee payers, staking rewards) it eliminates entire rounds.

### Delta-Weighted Water-Filling
When the budget allows multiple gap fills, gaps are prioritised by
`|delta| = |firstB.preLamports − lastA.postLamports|`. A 10 SOL jump is more likely
to contain hidden transactions than a 0.001 SOL fee drip. Larger deltas get budget
first.

### Anchor-First Slot Bounding
Unlike the competitor's implementation (which probed from slot 0 to chain tip —
410M slots), V1 runs anchor probes first to establish the wallet's actual activity
window. For a wallet created in 2025, this collapses the search space from 400M
slots to ~5M, making every subsequent window query dramatically faster.

### Budget-Capped Refinement Rounds
`maxRpcCalls` acts as a hard ceiling. The coordinator can tune this separately from
`maxRounds` to balance completeness vs latency per wallet tier.

---

## Obstacles Encountered

### Spurious `paginationToken` on Tiny Wallets
Helius returns a non-null `paginationToken` even when the full history fits in one
page (e.g. 4-txn wallet). The initial fast-exit checked `!paginationToken`, which
never triggered. **Fix:** use the overlap condition instead —
`oldestLastSlot >= newestFirstSlot` proves the two anchor pages cover everything.

### Budget Counter Mismatch
`rpcCalls` counted windows, not actual API calls. Windows that paginated internally
(3 pages of 100 to hit the 300-txn window limit) blew past `maxRpcCalls=40`,
reaching 133 calls on the dense wallet. **Fix:** check `rpc.callCount()` (the real
client-side counter) for all budget guards.

### CLI Guard Firing on Import
The `if (address && apiKey)` CLI block at the bottom of `sol_balance.mjs` read from
`process.argv` and fired when coordinator.mjs imported the file, treating the
coordinator's API key as a wallet address. **Fix:** guard with
`import.meta.url === new URL(process.argv[1], 'file://').pathname`.

### Dynamic Hypotheses Not Visible to Child Processes
Gen 2+ hypotheses (`gen2-golomb-5`, `gen2-cross-top2`) were registered in the
coordinator process's `HYPOTHESIS_REGISTRY` but each spawned agent is a fresh Node
process with only the static registry. **Fix:** moved `resolveDynamicHypothesis` to
`agent.mjs` and exported it; coordinator imports and reuses it.

### Golomb Probes Firing From Slot 0
First iteration probed `[0, tipSlot]` rather than `[minSlot, maxSlot]`, wasting
calls on 400M empty slots before the wallet was created. **Fix:** run anchor probes
first to establish `[minSlot, maxSlot]`, then Golomb-probe only that range.

---

## What Can Be Enhanced

| Area | Current | Enhancement |
|---|---|---|
| Window overflow | Paginates 100/page inside each window — 3 calls per 300-txn window | Use signatures endpoint to size windows exactly, eliminating internal pagination |
| Density estimation | Golomb is alias-free but still blind to where transactions cluster | Pre-scan with 1 signature call to get exact cluster locations |
| Continuity oracle scope | Only checks adjacent windows | Check oracle across all pairs of adjacent known samples, not just window boundaries |
| Refinement strategy | Sequential rounds, each a full parallel batch | Prioritise gaps dynamically mid-round rather than rebuilding gap list each round |
| Golomb order tuning | Fixed order per run | Adapt Golomb order based on estimated density (sparse → order 4, dense → order 8) |
| Large wallet support | Hits `maxRpcCalls` budget, leaves open gaps | Multi-tier budget: cheap sig scan first, then targeted full fetches |

---

## Autoresearch Findings (3 Generations, Parallel Agents)

Gen 1 winner: `large-probe-window` — setting `windowLimit=300` was the biggest single
gain (score 0.078 → 0.244). Larger windows capture more per call.

Gen 3 winner: `gen3-concurrency-12` — `maxRounds=0` + `windowLimit=300` = no
iterative refinement, just one pass of large Golomb probes. Score 0.398, 2.4s avg.

**Key convergence:** zero refinement rounds wins because with 300-txn windows the
Golomb probes already capture the entire history in the first pass for test wallets.
Refinement rounds add serial latency without benefit.

**All-time best config:**
```json
{
  "golombOrder": 6,
  "probeWindowLimit": 300,
  "windowLimit": 300,
  "maxRpcCalls": 10,
  "maxRounds": 0,
  "maxConcurrency": 12,
  "useContinuityOracle": true,
  "skipZeroDelta": true
}
```
Score: **0.398** | Avg latency: **2.4s** | Total calls: **18**
