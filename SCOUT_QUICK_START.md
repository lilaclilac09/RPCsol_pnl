# 🚀 Scout Algorithm Implementation — Quick Start

## Status
✅ **Three Scout implementations created**:
1. `sol_balance_scout.mjs` — HTTP/2 optimized (advanced)
2. `sol_balance_scout_v2.mjs` — Fetch-based Level 1 (recommended start)
3. `sol_balance_scout_v3.mjs` — Level 2 with streaming (faster)

---

## 🎯 Immediate Next Steps (15 minutes)

### 1. Run Scout V2 Benchmark
```bash
export HELIUS_API_KEY=your-key-here
node bench_scout_v2.mjs
```

**Expected output**:
```
🚀 Scout V2 Performance Benchmark
════════════════════════════════════════════════════════════════

📊 Sparse (5 txs)
   Address: 54uJifihfpmTjCGperSxW...
──────────────────────────────────────────────────────────────
   V15 (old)...
     ✅ 450ms | 8 RPC calls | 5 samples
   Scout V2 (new)...
     ✅ 280ms | 6 RPC calls | 5 samples

   ⚡ Speedup: 1.6x | Time saved: 38%
```

### 2. Success Criteria
Check:
- ✅ Scout completes without errors
- ✅ Speedup ≥ 1.5x vs V15
- ✅ Same sample count as V15
- ✅ RPC calls ≤ V15's calls

### 3. If Successful: Try V3 (Streaming)
```bash
# Quick single-wallet test
export HELIUS_API_KEY=your-key  
node sol_balance_scout_v3.mjs 54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs
```

Expected:
- `sol_balance_scout_v3.mjs` should be **2-3x faster** than V15
- Use for next iteration if benchmark is positive

---

## 📊 Full Benchmark Suite

### All Three Wallets
```bash
export HELIUS_API_KEY=your-key
node bench_scout_v2.mjs 2>&1 | tee scout_benchmark.txt
```

Captures output to `scout_benchmark.txt` for analysis.

### Compare V2 vs V3
```bash
# Create a comparison script
cat > bench_v2_vs_v3.mjs << 'EOF'
import { solBalanceScoutV2 } from "./sol_balance_scout_v2.mjs";
import { solBalanceScoutV3 } from "./sol_balance_scout_v3.mjs";

const address = "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs";
const apiKey = process.env.HELIUS_API_KEY;

console.log("V2 vs V3 Comparison");
console.log("═".repeat(60));

console.log("\nV2 (Level 1)...");
const t0_v2 = performance.now();
const r2 = await solBalanceScoutV2(address, apiKey);
const time_v2 = performance.now() - t0_v2;
console.log(`${time_v2.toFixed(0)}ms | ${r2.stats.totalRpcCalls} calls | ${r2.stats.sampleCount} samples`);

console.log("V3 (Level 2 + Streaming)...");
const t0_v3 = performance.now();
const r3 = await solBalanceScoutV3(address, apiKey);
const time_v3 = performance.now() - t0_v3;
console.log(`${time_v3.toFixed(0)}ms | ${r3.stats.totalRpcCalls} calls | ${r3.stats.sampleCount} samples`);

console.log(`\nV3 speedup over V2: ${(time_v2 / time_v3).toFixed(1)}x`);
EOF

node bench_v2_vs_v3.mjs
```

---

## 🔄 Iteration Workflow

### If Speedup is Good (≥1.5x)

```bash
# 1. Create Scout eval file (copy from V15 structure)
cp eval_v15.mjs eval_scout.mjs

# 2. Update to use Scout V2
sed -i 's/from "\.\/sol_balance_v15\.mjs"/from ".\/sol_balance_scout_v2.mjs"/' eval_scout.mjs
sed -i 's/solBalanceOverTime/solBalanceScoutV2/' eval_scout.mjs

# 3. Run evaluation
export HELIUS_API_KEY=your-key
node eval_scout.mjs

# 4. Compare scores
echo "Scout score:"
node eval_scout.mjs | grep '"score"'
echo "V15 score:"
node eval_v15.mjs | grep '"score"'
```

### If Speedup is Poor (<1.5x)

Debug with logging:

```javascript
// Add to sol_balance_scout_v2.mjs after each phase
console.log(`Phase 0: ${rpc.callCount()} calls`);
console.log(`Phase 1: ${rpc.callCount()} calls`);
console.log(`Discovered ${allSigs.length} total signatures`);

// Check: Are we hitting rate limits?
// If many retries, reduce maxConcurrency:
// strategy.maxConcurrency = 30  // Instead of 50
```

---

## 📈 Performance Targets

| Level | Implementation | Expected vs V15 | Time to Implement |
|-------|----------------|-----------------|------------------|
| L1 | Scout V2 | **1.5-2.5x** | ✅ Done |
| L2 | Scout V3 + adaptive slicing | **2-3x** | ✅ Done |
| L3 | Streaming + dedup during fetch | **3-4x** | 2-3 hours |
| L4 | HTTP/2 + connection pooling | **4-5x** | 3-4 hours |

---

## 🧪 Test Wallets

These are the three standardized test wallets:

```javascript
const TEST_WALLETS = [
  {
    address: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs",
    type: "sparse",                    // ~5 transactions
    expectedMinSamples: 4,
    baseline_V15_ms: 450,
    target_Scout_ms: 300,              // 1.5x
  },
  {
    address: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs",
    type: "medium",                    // ~50 transactions
    expectedMinSamples: 30,
    baseline_V15_ms: 800,
    target_Scout_ms: 400,              // 2x
  },
  {
    address: "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n",
    type: "dense",                     // ~200 transactions
    expectedMinSamples: 100,
    baseline_V15_ms: 1200,
    target_Scout_ms: 400,              // 3x
  },
];
```

---

## 🎓 Understanding Scout's Algorithm

```
Phase 0 (2 parallel sig calls):
├─ getSignatures(address, 1000)          # oldest 1000
└─ getSignatures(address, 1000)          # newest 1000
   Result: Density anchors, 1-2% of full-tx cost
   Time: 1 RPC round-trip

Phase 1 (Gap scouting — only if busy):
├─ Scout slice 1: getSignatures(address)
├─ Scout slice 2: getSignatures(address)
├─ ...
└─ Scout slice N: getSignatures(address)
   Result: Learn gap structure cheaply
   Time: Parallel, so ~1 RPC round-trip for N slices

Phase 2 (Full-fetch streaming):
├─ Chunk sigs into groups of 50
├─ Batch fetch all chunks in parallel
└─ Results stream back as they complete
   Result: All balance points
   Time: Parallel, so ~1 RPC round-trip for all chunks
```

**Why fast?**
- Signatures are 10x cheaper than full transactions
- Phases 1 & 2 can coexist (start fetching while scouting)
- Higher concurrency (50-100 vs V15's 12)
- Better batching (Oracle pagination vs individual fetches)

---

## 🐛 Troubleshooting

### "Timed out" or many retries
**Cause**: Rate limit (429) or network issue
**Fix**: Lower `maxConcurrency`
```javascript
// In bench_scout_v2.mjs:
const result = await solBalanceScoutV2(address, apiKey, {
  maxConcurrency: 30,  // Lower from 50
});
```

### Scout slower than V15
**Cause**: RPC call overhead or retry storms
**Debug**:
```javascript
// Add logging to sol_balance_scout_v2.mjs
console.log(`RPC calls: ${rpc.callCount()}`);
console.log(`Discovered sigs: ${allSigs.length}`);
// Should see < V15's call count
```

### Different transaction counts
**Cause**: Phase 1 missing some signatures in busy wallets
**Fix**: Increase `phase1NumSlices` in strategy
```javascript
const result = await solBalanceScoutV2(address, apiKey, {
  maxConcurrency: 50,
  phase1NumSlices: 12,  // Increase from 6
});
```

---

## 📋 Checklist for Integration

When Scout V2+ is ready:

- [ ] Scout V2 benchmark shows ≥1.5x speedup
- [ ] All 3 wallets complete successfully  
- [ ] RPC call count ≤ V15's calls
- [ ] No rate limit errors (429s)
- [ ] Sample count matches V15
- [ ] Create `eval_scout.mjs` using Scout
- [ ] Compare eval scores vs `eval_v15.mjs`
- [ ] If ≥1.5x faster with same samples → merge into test suite

---

## 🚀 Next Steps (After Benchmark)

### If ≥1.5x speedup achieved:
1. Integrate Scout V2 into main test suite
2. Add to `test_all_wallets_enhanced.mjs` as option
3. Use EvoHarness to auto-tune Scout parameters (phase1NumSlices, maxConcurrency)

### If <1.5x or issues:
1. Debug using checklist above
2. Try sol_balance_scout_v3.mjs (with streaming)
3. Compare RPC call counts

### For 3-5x speedup (full optimization):
1. Implement true streaming in Phase 2
2. Add HTTP/2 connection pooling
3. Profile with verbose timing logs

---

## 📚 Reference Files

- **Implementations**: `sol_balance_scout_v2.mjs`, `sol_balance_scout_v3.mjs`
- **Benchmarks**: `bench_scout_v2.mjs`
- **Docs**: `SCOUT_ITERATION_PLAN.md` (detailed technical guide)
- **Original reference**: https://github.com/Oliverpt-1/sol-pnl-challenge

---

## 🎯 Success Criteria

✅ **Immediate Win**: Scout V2 is 1.5-2.5x faster than V15
✅ **Medium Win**: Scout V3 is 2-3x faster than V15  
✅ **Big Win**: Full optimization reaches 3-5x speedup
✅ **Excellent**: Integrate into test suite and auto-tune with EvoHarness

---

Good luck! Let's beat Oliver's 0.256s. 🚀
