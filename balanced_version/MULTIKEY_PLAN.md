# Multi-Key Distributed Fetching — Plan

## Problem

A single Helius Developer plan key rate-limits under heavy parallel load.
Phase 1 fires 40–64 concurrent band requests. Phase 2 fires up to 556 chunk requests for large wallets.
One key cannot sustain that throughput — you get HTTP 429.

## Idea: treat API keys like GPUs

Each API key is an independent bandwidth channel with its own rate limit.
Split the work across N keys in round-robin — throughput scales linearly with key count.

```
Single key:   [band0] [band1] [band2] ... → 429 on large wallets
              all hitting the same rate limit

3 keys:       key[0]: [band0] [band3] [band6] ...
              key[1]: [band1] [band4] [band7] ...   → 3× throughput
              key[2]: [band2] [band5] [band8] ...
```

Same logic applies to Phase 2 chunk fetch — distribute chunks across keys.

## Design

### API

```js
import { fetchBalanceHistoryMultiKey } from "./test_multikey.mjs";

const result = await fetchBalanceHistoryMultiKey(
  "wallet-address",
  [
    "api-key-1",
    "api-key-2",
    "api-key-3",
  ]
);
```

Each key gets its own undici pool (16 connections each). Total pool = N × 16 = 48 connections for 3 keys — same as single-key but load spread across 3 rate limits.

### Phase 1 distribution

```
bands = _calcBands(...)          // e.g. 40 bands for a 30k tx wallet
key assignment = band index % N  // round-robin
```

Each key fetches its assigned bands fully independently. No shared state, no coordination needed.

### Phase 2 distribution

```
chunks = ceil(totalSigs / 90)    // e.g. 556 chunks for 50k txs
key assignment = chunk index % N
```

### Result merge

Each key returns its slice. Merge all results, dedup by signature, sort by slot. Same output as single-key path.

## Throughput math

| Keys | Max parallel bands | 50k wallet projected time |
|------|--------------------|--------------------------|
| 1 | 64 | ~4.6s (429 likely) |
| 2 | 128 | ~2.8s |
| 3 | 192 | ~2.1s |
| 5 | 320 | ~1.6s |
| 10 | 640 | ~1.1s |

For 1M tx wallets: even 10 keys won't beat the full-tx fetch wall (174 RTTs × 400ms). L0 cache is the only real fix at that scale.

## Limitations

- Each key still needs Developer plan access — free keys 429 regardless of count
- Round-robin assumes uniform key rate limits — if one key is slower, it becomes the bottleneck
- No failover if a key expires mid-run (can add: re-queue failed bands to next available key)

## Future additions

1. **Key health monitoring** — track 429 rate per key, route away from degraded keys
2. **Adaptive chunk sizing** — if a key is slow, give it fewer chunks next round
3. **L0 cache** — in-memory cache keyed by wallet address. 0 API calls on warm hit. Invalidate on new slot detected. Only real fix for 1M+ tx wallets.
4. **Failover** — if a band 429s after retries, reassign to least-loaded key
