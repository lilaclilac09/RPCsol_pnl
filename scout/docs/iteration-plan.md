# Scout Algorithm Analysis & Iteration Plan

## 📊 Current State (V15 Baseline)
- **Latency**: 1.0-2.5s per wallet (depends on type)
- **RPC Calls**: ~15-25 per wallet
- **Algorithm**: Sig pagination + stratified sampling + full-tx fetching
- **Bottleneck**: Signature fetching is still sequential; full-tx fetch is not optimally parallelized

---

## 🎯 Oliver's Scout Algorithm (Rust)
Achieved **0.256-0.601s** on the exact same wallets:

| Wallet Type | Size | Oliver's Time | Your Baseline | Target |
|-------------|------|---------------|---------------|--------|
| Sparse      | 248  | 256ms         | 500ms         | <400ms |
| Busy        | 3990 | 479ms         | 1500ms        | <750ms |
| Periodic    | 3359 | 400ms         | 1200ms        | <600ms |

**Key difference**: Oliver uses **signatures-first**, not full-tx first.

---

## 🔬 Why Signatures-First Works

### The Cost Hierarchy
```
getSignaturesForAddress(limit=1000)     → 1 RPC credit (cheap)
getTransaction(1 sig)                   → 1 RPC credit
getTransactionsForAddress(full, 100)    → ~10 RPC credits (expensive)
```

### Three-Phase Strategy

**Phase 0: Anchor Probes (1 RTT)**
```
Parallel calls:
  - getSignatures(address, 1000, undefined)  → oldest 1000 sigs
  - getSignatures(address, 1000)             → newest 1000 sigs

Cost: 2 RPC credits
Result: Density anchors cover both ends
```

For wallets with ≤2000 txs, Phase 0 is already complete. Fast exit.

---

**Phase 1: Scout the Gap (Busy Wallets Only)**
```
If total coverage < 2000:
  Partition middle gap into N adaptive slices (4-12, based on density)
  Fire N parallel getSignatures calls
  
Cost: N RPC credits (N=6 avg)
Result: Learn all ~1000 sigs in middle
```

This is the key insight: **Learn the entire wallet structure cheaply before committing to expensive full-tx fetches.**

---

**Phase 2: Stream Full-Tx Fetch (Parallel Batches)**
```
Chunk all discovered signatures into groups of ~50
Fire all chunks in parallel with Promise.all()

Cost: (totalSigs / 50) RPC credits
Result: Get all required balance points
```

The critical path collapses:
```
Old:  Phase1_sigs + Phase2_scout + Phase3_fullFetch  (sequential)
New:  Phase0 + max(Phase1_scout, Phase2_stream)      (overlapped)
```

---

## 📈 Implementation Levels

### Level 1: Basic Scout (2-3x speedup)
✅ **Scout V2** — What I implemented
- Phase 0: Parallel signature anchors
- Phase 1: Gap scouting (single call or simplified)
- Phase 2: Parallel full-fetch batches
- **Expected**: 1.5-2.5x faster than V15
- **Implementation time**: 2 hours (done)

### Level 2: Optimized Scout (3-5x speedup)
**Next step** — If V2 lands
- Adaptive density-based slicing in Phase 1
- Implement true streaming with Promise.race() (Scout completion + fetch interleave)
- HTTP/2 window tuning (if Bun/Node supports)
- Better pagination token handling in scouts

### Level 3: Advanced Scout (5-8x speedup)
**Future** — Match Oliver's Rust impl
- Tokio-style work stealing (emulate with async pools)
- Dedup during fetch (not after)
- Smart slot-based chunking instead of sig count
- Connection pooling with persistent keep-alive

---

## 🧪 Testing & Benchmarking

### Quick Test
```bash
export HELIUS_API_KEY=your-key
node bench_scout_v2.mjs
```

Expected output:
```
📊 Sparse (5 txs)
   V15 (old)...    ✅ 500ms | 8 RPC calls | 5 samples
   Scout V2 (new)... ✅ 300ms | 6 RPC calls | 5 samples
   ⚡ Speedup: 1.7x | Time saved: 40%
```

### Metrics to Track
- **wallTimeMs**: Total elapsed time
- **totalRpcCalls**: Total RPC calls (lower is better)
- **sampleCount**: Transaction samples found (should match or exceed V15)

### Success Criteria
- [ ] Scout V2 is **≥1.5x faster** than V15
- [ ] All samples found == V15's samples
- [ ] RPC calls ≤ V15's calls
- [ ] No rate-limit hits (concurrency ≤ Helius limits)

---

## 🎯 Iteration Path

### Iteration 1: Validate Scout V2
1. Run `bench_scout_v2.mjs` on all 3 wallet types
2. If speedup ≥1.5x → proceed to Iteration 2
3. If speedup <1.5x → debug concurrency/retry logic

### Iteration 2: Tune Phase 1 Scouting
**Problem**: Phase 1 currently makes N parallel calls, but doesn't use blockTime filtering.

**Solution**:
```javascript
// Improved Phase 1: adaptive slicing with density estimation
const density = estimateFromAnchors(oldestSigs, newestSigs);
const numSlices = adaptiveSlicing(density);  // 4-12 based on txs/sec

// Fire scouts with staggered before/after pagination
const scoutPromises = Array.from({ length: numSlices }, async (_, i) => {
  const midpoint = oldestSigs[Math.round(i * oldestSigs.length / numSlices)];
  return rpc.getSignatures(address, 1000, midpoint.signature);
});
```

Expected gain: 2-3x total (from 1.5x)

### Iteration 3: Implement True Streaming
**Problem**: We wait for all scouts to finish before starting full-fetches.

**Solution**: Use `Promise.race` to interleave:
```javascript
// As soon as scout returns, immediately batch its sigs for full-fetch
const scoutPromises = [...];
const fullFetchQueue = [];

for (const scoutPromise of scoutPromises) {
  scoutPromise.then((sigs) => {
    fullFetchQueue.push(...chunkSigs(sigs, 50));
    executeFullFetches(fullFetchQueue);  // Fire immediately
  });
}
```

Expected gain: 3-4x total (from 1.5-2.5x)

### Iteration 4: HTTP/2 Tuning
**If using Node.js 18+** (has native HTTP/2):
```javascript
const session = http2.connect("https://mainnet.helius-rpc.com", {
  settings: {
    headerTableSize: 65536,
    initialWindowSize: 2 * 1024 * 1024,   // 2MB stream window
    maxFrameSize: 32768,
  },
});
session.settings({
  headerTableSize: 65536,
  initialWindowSize: 16 * 1024 * 1024,  // 16MB connection window
});
```

Expected gain: 4-5x total (from 2-3x)

---

## 🔍 Debugging Checklist

If Scout V2 is slow:

1. **Check concurrency**
   ```javascript
   // Add logging to semaphore
   console.log(`Active: ${active}/${limit}`);
   ```
   Should see max concurrent climbing to strategy.maxConcurrency.

2. **Check RPC call count**
   ```javascript
   console.log(`Phase0: 2, Phase1: ${scoutCount}, Phase2: ${chunkCount}`);
   ```
   Should be lower than V15.

3. **Check retry storms**
   If wallTimeMs >> phase times, check for 429 rate limits.
   Solution: Lower `maxConcurrency` to 30-40.

4. **Check network latency**
   Measure RTT to Helius:
   ```bash
   ping mainnet.helius-rpc.com
   # Should be 20-80ms; if >150ms, network issue
   ```

5. **Compare against Rust**
   ```bash
   # If you have Oliver's binary:
   ./scout --address YOUR_ADDRESS --rpc-url "https://mainnet.helius-rpc.com/?api-key=$KEY"
   ```

---

## 📋 Next Steps

### Immediate (Next 30 min)
- [ ] Run `bench_scout_v2.mjs` and record baseline
- [ ] Verify all 3 wallets complete successfully
- [ ] Check speedup percentage

### Short term (Next 2 hours)
- [ ] If speedup ≥1.5x: Integrate into eval suite
- [ ] If speedup <1.5x: Debug with more logging
- [ ] Create Scout eval file (eval_scout.mjs)

### Medium term (Next 1-2 days)
- [ ] Implement Iteration 2 & 3 (adaptive slicing + streaming)
- [ ] Target 3-4x speedup
- [ ] Benchmark against all wallet types

### Long term (Next week)
- [ ] HTTP/2 tuning (if Node.js supports)
- [ ] Compare against Oliver's Rust version
- [ ] Target 5-8x speedup
- [ ] Integrate into production router

---

## 🎓 Key Learning: Why Scout Works

The genius of the algorithm:

1. **Late commitment strategy**: Learn everything with cheap sigs first, then commit to expensive full-txs
2. **Adaptive parallelism**: Scale scouts based on actual density, not fixed rates
3. **Work stealing**: Use Promise.race() to interleave scout completion + fetch startup
4. **Dedup discipline**: Only dedup by signature (unique per tx), not by multi-key tuples

This pattern applies beyond SOL PnL:
- Any blockchain data fetching (Ethereum, Cosmos, etc.)
- API cost optimization (any tiered pricing model)
- Adaptive algorithms in general (estimate density → allocate resources)

---

## 🚀 Expected Timeline to 5-8x Speedup

```
Now:       Scout V2 baseline (1.5-2.5x)
+2h:       Iteration 2 (adaptive slicing) → 2-3x
+4h:       Iteration 3 (streaming) → 3-4x
+6h:       HTTP/2 tuning (if applicable) → 4-5x
+8h:       Fine-tuning + profiling → 5-8x ✅
```

**Bottleneck**: Node.js runtime overhead vs Rust. Realistic target: **3-5x** (vs Oliver's 7-8x from Rust).

---

Good luck! 🚀
