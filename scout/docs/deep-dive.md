# Scout Algorithm Deep Dive: Technical Analysis

> **Goal**: Understand why Scout is 3-8x faster than V15, and how to replicate it.

---

## 1. The Cost Model

Every RPC call has a **credit cost** on Helius. Understanding this is key:

### Signature Fetching (Cheap)
```
getSignaturesForAddress(address, limit=1000)
  → Returns: Array<{ signature, blockTime, slot, err }>
  → Cost: 1 RPC credit per call
  → Data volume: ~50KB per call
```

### Transaction Fetching (Expensive)
```
getTransaction(signature)
  → Returns: Full Tx { transaction, meta, blockTime, slot }
  → Cost: 1 RPC credit per call (free tier) or higher (paid)
  → Data volume: ~5-50KB per trans

getTransactionsForAddress(address, transactionDetails="full", limit=100)
  → Returns: Array<FullTx> of 100 items
  → Cost: ~10 RPC credits per call (expensive!)
  → Data volume: ~200-500KB per call
```

### Cost Hierarchy
```
1 RPC = 1 sig fetch ≈ 1 full tx fetch ≈ 0.1 × "full" batch fetch

In terms of time+bandwidth:
- getSignatures(1000):      2-5ms + 50KB
- getTransaction(1 sig):    50-100ms + 5-20KB
- getTransactionsForAddress(full, 100): 100-200ms + 200-500KB (rate limit issue!)
```

---

## 2. V15's Approach (Current Baseline)

### Algorithm
```
1. Fetch signature pagination (sequential gSFA calls)
   - Keep calling getSignaturesForAddress until all sigs are fetched
   - Cost: O(N/1000) calls, where N = wallet transaction count

2. Stratified sampling
   - Select samples evenly across the signature history

3. Fetch selected transactions
   - Use getTransaction(sig) for each selected signature
   - Parallel with concurrency limit (max 12)
```

### Example: Busy Wallet (3990 txs)
```
Phase 1: Signature pagination
  Call 1: getSignatures(limit=1000)  → sig[0-999]
  Call 2: getSignatures(limit=1000)  → sig[1000-1999], before=sig[999]
  Call 3: getSignatures(limit=1000)  → sig[2000-2999], before=sig[1999]
  Call 4: getSignatures(limit=1000)  → sig[3000-3989], before=sig[2999]
  Cost: 4 calls, 4+ RTTs (slow!)

Phase 2: Stratified sampling
  Select indices: [0, 1000, 2000, 3000] → 4 samples
  OR with more target: [0, 400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600]

Phase 3: Fetch transactions (parallel)
  getTransaction(sig[0])  ↓
  getTransaction(sig[1000]) ↓
  getTransaction(sig[2000]) ↓ Parallel (max 12)
  getTransaction(sig[3000]) ↓
  Cost: 10+ calls, 2-3 RTTs
  
Total: 14+ calls, 6-7 sequential RTTs = 600-1400ms
```

### Why slow?
1. **Sequential sig pagination**: Doesn't learn density upfront
2. **Forced to pick samples**: Can't fetch everything; hope samples are representative
3. **Limited parallelism**: Cap at 12 concurrent (rate limit safety)
4. **Round-trip overhead**: Each phase must complete before next starts

---

## 3. Scout's Approach (This Implementation)

### Key Insight: Density-First, Greedy Fetching

```
Define "density" = (known_txs / time_span)
  At startup, unknown. Estimate from anchors.
  
Strategy:
  1. Learn density with cheap signature probes
  2. Use density to allocate resources
  3. Fetch everything parallel, not samples
```

### Phase 0: Anchor Probes (1 RTT)

```
Parallel calls:
  getSignatures(address, 1000)        → oldest 1000 sigs (10+ years back)
  getSignatures(address, 1000)        → newest 1000 sigs (recent)

Result:
  - If total < 2000: Done! (sparse wallet)
  - If total ≥ 2000: Gap between anchors needs scouting

Cost: 2 calls, 1 RTT
Latency: 50-200ms
```

### Phase 1: Gap Scouting (1 RTT, but for dense only)

```
Estimate density from anchors:
  density = max(txs_per_sec_oldest, txs_per_sec_newest, txs_per_sec_middle)

Adaptive slicing:
  numSlices = max(4, min(12, ceil(density / 50)))
  
Scout in parallel (stratified):
  for i in 0..numSlices-1:
    midpoint_idx = i * (anchors.length / numSlices)
    getSignatures(address, 1000, before=anchors[midpoint_idx])

Cost: numSlices calls (4-12), all parallel = 1 RTT
Latency: 50-200ms
Total discovered: ~4000-12000 signatures
```

### Phase 2: Streaming Full-Fetch

```
Chunk signatures into groups of ~50:
  chunks = [sigs[0:50], sigs[50:100], ..., sigs[N:N+50]]

For each chunk, fire getTransaction in parallel:
  Promise.all(chunk.map(sig => rpc.getTransaction(sig)))

Interleave: As Phase 1 scouts complete, immediately add their chunks to Phase 2 queue

Cost: (numSigs / 50) getTransaction calls
Parallelism: All chunks fire together
Latency: ~100-300ms
```

### Example: Same Busy Wallet (3990 txs)

```
Phase 0: Anchors
  Oldest 1000: [3990, 3989, ..., 2991]
  Newest 1000: [999, 998, ..., 0]
  Cost: 2 calls, 1 RTT = 100ms

Phase 1: Gap scouting (between slot 2991 and 999)
  Estimate density from anchors
  Slice 1: getSignatures(before=sig[2500])
  Slice 2:getSignatures(before=sig[2000])
  Slice 3: getSignatures(before=sig[1500])
  Slice 4: getSignatures(before=sig[1000])
  Cost: 4 calls in parallel, 1 RTT = 100ms
  Discovered: ~3000-4000 new sigs

Phase 2: Stream full-fetch
  chunks = [80 chunks of ~50 sigs each]
  Fire all 80 getTransaction calls in parallel (batches)
  Cost: 80 calls, but concurrent limit 50 = 2 RTTs = 200ms
  
Total: 2 + 4 + 80 = 86 calls, but massively parallel
Latency: 100 + 100 + 200 = 400ms ✅ (vs V15's 1200ms)
```

---

## 4. Why Scout is Faster: Numbers

### Call Count
```
V15 (busy wallet):    14 calls
Scout:                86 calls (but cheaper + parallel)
```

Seems like Scout uses 6x more calls, but:
- V15: Some calls are expensive getTransactionsForAddress
- Scout: All calls are cheap getSignatures or getTransaction
- Scout parallelizes; V15 is sequential

### Round-Trip Time
```
V15:  6-7 RTTs (sequential phases)
Scout: 3 RTTs (Phase 0 + Phase 1 ∥ Phase 2_anchor + Phase 2_gap)
       = 100ms + 100ms + 200ms = 400ms
```

### Walltime
```
V15:   6-7 RTTs × 50-100ms each + jitter = 300-700ms overhead + 500ms calls = 800-1200ms
Scout: 3 RTTs × ~100ms + parallel overhead = 300-400ms
```

---

## 5. Implementing Scout Optimizations

### Level 1 (Done): Basic Scout V2
✅ Phase 0: Parallel anchors
✅ Phase 1: Simple gap scout (all in parallel)
✅ Phase 2: Chunked batch fetch
**Expected**: 1.5-2.5x faster

### Level 2 (Done): Scout V3 with Streaming
✅ Adaptive slicing (density-based)
✅ True streaming (start Phase 2 while Phase 1 scouts)
✅ Better pagination hints
**Expected**: 2-3x faster

### Level 3 (Future): Advanced Streaming
- Use `Promise.race()` to interleave scout completion + fetch startup
- Implement per-slot chunking (instead of sig count)
- Dedup during fetch (not after)
**Expected**: 3-4x faster

### Level 4 (Future): HTTP/2 Optimization
- Connection pooling with persistent keep-alive
- Larger HTTP/2 windows (2MB stream, 16MB connection)
- Compression (gzip + brotli)
**Expected**: 4-5x faster

---

## 6. Measuring Scout Performance

### Key Metrics

```javascript
// In benchmark, track:
const metrics = {
  wallTimeMs:        performance.now() - start,  // Total elapsed
  totalRpcCalls:     rpc.callCount(),             // # of RPC calls made
  signaturesFound:   allSigs.length,              // Total unique sigs discovered
  transactionsFound: points.length,               // Unique balance points
  phase0Latency:     time_phase0,                 // RTT 0 only
  phase1Latency:     time_phase1,                 // RTT 1 only
  phase2Latency:     time_phase2,                 // RTT 2 only
  rpcCreditsUsed:    calculation(calls, types),   // Approx credits
};
```

### Benchmark Comparison Formula

```javascript
const speedup = v15_wallTimeMs / scout_wallTimeMs;
const rpcImprovement = ((v15_calls - scout_calls) / v15_calls) * 100;
const sampleCheck = scout_samples === v15_samples ? "✅" : "⚠️";

console.log(`Speedup: ${speedup.toFixed(1)}x`);
console.log(`RPC efficiency: ${rpcImprovement.toFixed(0)}% fewer (or more for coverage)`);
console.log(`Sample match: ${sampleCheck}`);
```

### Success Thresholds

| Metric | Level 1 | Level 2 | Level 3 | Level 4 |
|--------|---------|---------|---------|---------|
| **Speedup** | 1.5x | 2.0x | 3.0x | 4.0x |
| **Sparse wallet latency** | <350ms | <300ms | <250ms | <200ms |
| **Busy wallet latency** | <800ms | <500ms | <400ms | <300ms |
| **RPC calls** | ≤ V15 | ≤ V15 × 1.2 | ≥ V15 (but faster) | ≥ V15 (much faster) |

---

## 7. Debugging Scout Issues

### Issue: Scout is slow, no speedup

**Checklist**:
```javascript
1. Check concurrency:
   if (rpc.callCount() / wallTimeMs < 2) {
     // Only 2 calls/sec = bottlenecked on semaphore/retries
     // Solution: Lower maxConcurrency to test, or check retries
   }

2. Check retry storms:
   if (retries > callCount * 0.5) {
     // More than 50% retry rate = rate limiting
     // Solution: Lower maxConcurrency, add backoff
   }

3. Check call composition:
   const sigCalls = callCount - getTransaction_calls;
   // Scout should have fewer getTransaction calls than V15

4. Check wall vs sum:
   if (wallTimeMs >> phase0 + phase1 + phase2) {
     // Something else is slow (parsing, dedup, etc.)
     // Solution: Profile with console.time()
   }
```

### Issue: Scout finds different sample count

**Cause**: Phase 1 scout incomplete (missed gap signatures)

**Solution**:
```javascript
// In sol_balance_scout_v2.mjs:
const { scoutedSigs } = await phase1Scout(rpc, address, oldestSigs, newestSigs, {
  phase1NumSlices: 12,  // Increase from 6
  phase1TargetDensity: 30,  // More granular
});
```

### Issue: Rate limit errors (429)

**Cause**: Too many concurrent requests

**Solution**:
```javascript
// Tune concurrency:
// Start with maxConcurrency: 30 (safe)
// Increase gradually: 40, 50, 60...
// Watch for 429 errors; if appear, drop back

const strategy = {
  maxConcurrency: 30,  // Conservative
  retryMax: 5,         // More resilient
  retryBaseMs: 250,    // Longer backoff
};
```

---

## 8. Optimization Priorities for Next Iteration

### Quick Wins (30 min each)
1. **Parallel anchor batching** → 10-20% speedup by eliminating RTT overhead
2. **Better retry backoff** → Avoid rate limit storms
3. **Dedup during fetch** → 5-10% memory + time savings

### Medium Efforts (1-2 hours)
1. **True streaming Phase 2** → 20-30% speedup
2. **Adaptive slicing** → 10-15% speedup
3. **Connection pooling** → 10% speedup if using persistent HTTP

### Long-term (Full day)
1. **HTTP/2 window tuning** → 20-40% speedup (if Node supports)
2. **Tokio-like work stealing** → 10-20% speedup
3. **GPU-accelerated dedup** (overkill, skip)

---

## 9. Reference: Oliver's Rust Implementation

From https://github.com/Oliverpt-1/sol-pnl-challenge:

```rust
// Phase 0: Cold-start TCP + TLS + h2 handshake, 2 parallel sigs calls
phase0_futures = [oldestSigs, newestSigs].join();

// Phase 1: Adaptive slicing
let num_slices = clamp(density as usize, 4..=12);
let mut scout_futures = FuturesUnordered::new();
for i in 0..num_slices {
  scout_futures.push(getSignatures(address, 1000));
}

// Phase 2: Stream full-fetch with biased select!
loop {
  select! {
    biased;
    Some(scout_res) = scout_futures.next() => {
      // New scout result: immediately enqueue for full-fetch
      for sig_batch in scout_res.chunks(50) {
        full_fetches.push(getTransaction_batch(sig_batch));
      }
    }
    Some(fetch_res) = full_fetches.next() => {
      // Full-fetch complete: drain into results
      results.extend(fetch_res);
    }
    else => break,
  }
}

// Critical path collapses:
// Old: phase0 + phase1 + phase2 = 3 RTTs
// New: phase0 + max(phase1_remaining, phase2_stream) ~= 2 RTTs
```

Key Rust techniques:
- `tokio::spawn()` for cheap async tasks
- `FuturesUnordered` for fair scheduling
- `select!` with `biased` for streaming prioritization
- HTTP/2 with large windows (2MB/16MB)

We can emulate most of this in JavaScript with Promise.race() and proper queue management.

---

## 10. Final Checklist: Before Declaring Victory

- [ ] Scout V2 is ≥1.5x faster than V15
- [ ] Scout V3 is ≥2.0x faster than V15
- [ ] All test wallets (sparse, medium, dense) pass
- [ ] Sample count matches V15
- [ ] RPC call count ≤ V15 (or explained reason why more)
- [ ] No rate limit errors (429s)
- [ ] Integrated into test suite
- [ ] EvoHarness can auto-tune Scout parameters
- [ ] Documentation updated
- [ ] Benchmarks repeatable and stable

---

Good luck! 🚀
