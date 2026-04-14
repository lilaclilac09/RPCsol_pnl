# 🔧 Scout Integration Guide

Quick reference for integrating Scout algorithms into your existing test and evaluation suite.

---

## 🚀 Option 1: Add Scout V2 to EvoHarness (Recommended)

### Step 1: Create eval_scout_v2.mjs

```javascript
// eval_scout_v2.mjs
import { solBalanceScoutV2 } from './sol_balance_scout_v2.mjs';

export async function evaluateScoutV2(wallets, iterations = 10, strategy = {}) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error('HELIUS_API_KEY not set');
  
  let totalScore = 0;
  const results = [];
  
  for (const wallet of wallets) {
    let walletScore = 0;
    
    for (let i = 0; i < iterations; i++) {
      try {
        const result = await solBalanceScoutV2(wallet, apiKey, strategy);
        const score = result.points || 0;
        walletScore += score;
        results.push({ wallet, iteration: i, score, success: true });
      } catch (error) {
        console.error(`❌ Wallet ${wallet} iteration ${i}: ${error.message}`);
        results.push({ wallet, iteration: i, error: error.message, success: false });
      }
    }
    
    const avgWalletScore = walletScore / iterations;
    totalScore += avgWalletScore;
    console.log(`  ${wallet}: ${avgWalletScore.toFixed(2)} (${iterations} iterations)`);
  }
  
  const finalScore = totalScore / wallets.length;
  return {
    score: finalScore,
    implementation: 'Scout V2',
    results,
    timestamp: new Date().toISOString(),
  };
}

// For GBrain parameter evolution
export function getSearchSpace() {
  return {
    maxConcurrency: { min: 10, max: 100, type: 'int' },
    retryBaseMs: { min: 50, max: 500, type: 'int' },
    phase0SigLimit: { min: 500, max: 2000, type: 'int' },
    phase1TargetDensity: { min: 20, max: 200, type: 'int' },
    phase2ChunkSize: { min: 20, max: 100, type: 'int' },
  };
}
```

### Step 2: Run in EvoHarness

```javascript
// In your coordinator.mjs or similar
import { evaluateScoutV2 } from './eval_scout_v2.mjs';

async function main() {
  const wallets = [...]; // your test wallets
  
  const result = await evaluateScoutV2(wallets, 5);
  console.log(`Scout V2 score: ${result.score.toFixed(3)}`);
  
  // Save to results
  fs.writeFileSync(
    `results_scout_v2/run_${Date.now()}.json`,
    JSON.stringify(result, null, 2)
  );
}

main();
```

### Step 3: Add to your leaderboard

```javascript
// In leaderboard generation
const scoutResults = {
  name: 'Scout V2',
  avgScore: 0.385,  // from result.score
  variance: 0.024,
  speedup: '1.8x', // from benchmark
  notes: 'Parallel 3-phase algorithm',
};
```

---

## 🚀 Option 2: Use Scout V3 (More Advanced)

### Step 1: Create eval_scout_v3.mjs

```javascript
import { solBalanceScoutV3 } from './sol_balance_scout_v3.mjs';

export async function evaluateScoutV3(wallets, iterations = 10, strategy = {}) {
  // Similar to V2 above, but using solBalanceScoutV3
  // V3 adds: adaptiveSlicing, densityEstimation
  // Same interface, just different internal algorithm
}

export function getSearchSpace() {
  return {
    ...V2SearchSpace,
    // V3 adds:
    adaptiveSlicesMin: { min: 2, max: 6, type: 'int' },
    adaptiveSlicesMax: { min: 8, max: 16, type: 'int' },
    densityTargetPhase1: { min: 30, max: 150, type: 'int' },
  };
}
```

---

## 🚀 Option 3: Integrate Scout Rust (Production)

### Step A: Build Rust binary

```bash
cd sol_balance_scout_rust
cargo build --release
# Binary: target/release/sol_balance_scout
```

### Step B: Create Node.js wrapper

```javascript
// scout_rust_wrapper.mjs
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function solBalanceScoutRust(address, apiKey, strategy = {}) {
  const binaryPath = path.join(__dirname, 'sol_balance_scout_rust/target/release/sol_balance_scout');
  
  return new Promise((resolve, reject) => {
    let output = '';
    
    const proc = spawn(binaryPath, [address], {
      env: { ...process.env, HELIUS_API_KEY: apiKey },
      timeout: 60000,
    });
    
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const lines = output.trim().split('\n');
          const jsonLine = lines.find(l => l.includes('"wallet"'));
          const result = JSON.parse(jsonLine || output);
          
          resolve({
            points: result.points || 0,
            stats: {
              totalRpcCalls: result.stats?.total_rpc_calls,
              sampleCount: result.stats?.sample_count,
            },
          });
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      } else {
        reject(new Error(`Rust process failed with code ${code}`));
      }
    });
    
    proc.on('error', reject);
  });
}
```

### Step C: Create eval wrapper

```javascript
// eval_scout_rust.mjs
import { solBalanceScoutRust } from './scout_rust_wrapper.mjs';

export async function evaluateScoutRust(wallets, iterations = 10) {
  // Same pattern as V2/V3
}
```

---

## 📊 Integration Comparison

### Easiest: Scout V2

```bash
# No build needed
node eval_scout_v2.mjs
# Integrates immediately into EvoHarness
```

**When:** You want fastest integration, 1.5-2.5x speedup is acceptable

**Effort:** 5 minutes  
**Risk:** Low (pure Node.js)

---

### Best Middle Ground: Scout V3

```bash
# No build needed
node eval_scout_v3.mjs
# Slightly more parameters to tune
```

**When:** You want 2-3x speedup, willing to tune streaming parameters

**Effort:** 10 minutes  
**Risk:** Low (pure Node.js, same eval interface)

---

### Best Performance: Scout Rust

```bash
# One-time build
cd sol_balance_scout_rust && cargo build --release

# Then use via wrapper
node eval_scout_rust.mjs
```

**When:** You need 3-4x speedup for production, team can handle Rust binary

**Effort:** 15-20 minutes  
**Risk:** Medium (subprocess management, binary distribution)

---

## ✅ Integration Checklist

### For Scout V2 (Recommended Start)

```
□ Copy sol_balance_scout_v2.mjs to your project root
  (already exists there)

□ Create eval_scout_v2.mjs
  (template above)

□ Test locally:
  $ HELIUS_API_KEY=your-key node eval_scout_v2.mjs

□ Add to coordinator:
  import { evaluateScoutV2 } from './eval_scout_v2.mjs';
  
  // In main loop:
  const scoutResult = await evaluateScoutV2(testWallets, 5);

□ Verify results directory:
  mkdir -p results_scout_v2

□ Run benchmarks:
  $ node bench_scout_v2.mjs  # compare to V15
  Expected: 1.5x+ speedup

□ If speedup >= 1.5x:
  - Integrate into leaderboard
  - Update documentation
  - Mark as available for EvoHarness

□ Done! 🎉
```

### For Scout Rust (Production Deployment)

```
□ Pre-requisites:
  - Rust toolchain installed
  - cargo build environment ready
  
□ Build Rust binary:
  $ cd sol_balance_scout_rust
  $ cargo build --release
  $ ls -lh target/release/sol_balance_scout
  (verify it exists, ~20MB)

□ Create wrapper:
  (use scout_rust_wrapper.mjs template above)

□ Create evaluator:
  (use eval_scout_rust.mjs template above)

□ Test wrapper:
  $ HELIUS_API_KEY=your-key node -e "
    import { solBalanceScoutRust } from './scout_rust_wrapper.mjs';
    const result = await solBalanceScoutRust('ADDRESS', process.env.HELIUS_API_KEY);
    console.log('Result:', result);
  "

□ Run full benchmark:
  $ node bench_scout_all.mjs --rust --verbose
  
□ Verify Rust is faster:
  Expected: 3-4x speedup vs V2
  
□ If faster:
  - Update production config to use Rust binary
  - Document binary location + build instructions
  - Plan distribution (Docker, CI artifact, etc.)

□ Done! 🎉
```

---

## 🔄 Migration Path

### Phase 1: Quick Win (Day 1)
```
V15 → Scout V2
- No build needed
- 1.5-2.5x speedup
- Immediate integration
- Run: node eval_scout_v2.mjs
```

### Phase 2: Optimization (Day 3-5)
```
Option A: Stick with V2
→ Fine-tune parameters via EvoHarness

Option B: Upgrade to V3
→ Enable streaming + adaptive slicing
→ Expected improvement: 0-30% faster than V2
```

### Phase 3: Production (Week 2)
```
Option: Build Rust
→ cargo build --release
→ Integrate via wrapper
→ Expected improvement: 2x faster than V2
→ Production-ready with binary shipping
```

---

## 📈 Performance Tracking

### Minimal Tracking

```javascript
const results = {
  timestamp: new Date().toISOString(),
  implementation: 'Scout V2',
  avgLatency: 425,  // ms
  speedup: '1.8x',  // vs V15
  wallTime: 2500,   // ms for all samples
};
```

### Detailed Tracking

```javascript
const results = {
  timestamp: new Date().toISOString(),
  implementation: 'Scout V2',
  wallets: [
    {
      address: '9B5X4jNGU8R6cVvAMbmF...',
      samples: 50,
      latencies: [425, 412, 438, ...],
      avgLatency: 425,
      p99Latency: 520,
      rpcCalls: 18,
      speedup: '1.8x',
    },
    // ... more wallets
  ],
  summary: {
    avgSpeedup: '1.75x',
    minSpeedup: '1.6x',
    maxSpeedup: '1.9x',
    totalRpcCalls: 540,
  },
};
```

---

## 🎯 EvoHarness Integration Example

### Add Scout V2 to your existing evolution loop

```javascript
// coordinator.mjs
import { evaluateScoutV2, getSearchSpace as getScoutV2SearchSpace } from './eval_scout_v2.mjs';

const IMPLEMENTATIONS = {
  v15: { eval: evaluateV15, searchSpace: getV15SearchSpace },
  scout_v2: { eval: evaluateScoutV2, searchSpace: getScoutV2SearchSpace },
  // scout_v3: { eval: evaluateScoutV3, searchSpace: getScoutV3SearchSpace },
  // scout_rust: { eval: evaluateScoutRust, searchSpace: {...} },
};

async function runEvolution(impl, generations = 3) {
  const { eval: evaluateFn, searchSpace } = IMPLEMENTATIONS[impl];
  
  for (let gen = 0; gen < generations; gen++) {
    // Mutate parameters
    const strategy = mutateParameters(searchSpace);
    
    // Evaluate
    const result = await evaluateFn(testWallets, 5, strategy);
    
    // Log
    console.log(`Gen ${gen}: ${impl} score=${result.score.toFixed(3)}`);
    
    // Save
    fs.writeFileSync(
      `results_${impl}/gen${gen}.json`,
      JSON.stringify({ strategy, result })
    );
  }
}

// Run evolution for each Scout variant
await runEvolution('scout_v2', 5);
// await runEvolution('scout_v3', 5);
// await runEvolution('scout_rust', 5);
```

---

## 📞 Troubleshooting Integration

### Issue: Import/export errors

**Solution:** Ensure files are in same directory
```
✓ sol_balance_scout_v2.mjs
✓ eval_scout_v2.mjs
✓ coordinator.mjs (all in project root)
```

### Issue: HELIUS_API_KEY undefined

**Solution:** Set before running
```bash
export HELIUS_API_KEY=your-key
node eval_scout_v2.mjs
```

### Issue: Rust binary not found

**Solution:** Build it
```bash
cd sol_balance_scout_rust
cargo build --release
# Binary at: sol_balance_scout_rust/target/release/sol_balance_scout
```

### Issue: Scout slower than V15

**Unlikely, but if it happens:**
- Run bench_scout_v2.mjs to verify
- Check RPC call count (should be ≤ V15)
- Check sample count (should match V15)
- Look for network latency spikes
- Re-run with fresh API key
- Contact Helius support if rate-limited

---

## 🎓 Next Steps

1. **Choose your path:**
   - Fast: Scout V2 (recommended)
   - Balanced: Scout V3
   - Production: Scout Rust

2. **Integrate:**
   - Copy appropriate implementation file
   - Create eval_scout_X.mjs wrapper
   - Test with your wallets

3. **Benchmark:**
   - Run bench_scout_all.mjs
   - Verify speedup vs V15
   - Check RPC call efficiency

4. **Deploy:**
   - Add to leaderboard
   - Enable in EvoHarness
   - Monitor results

---

**Questions?** See:
- SCOUT_QUICK_START.md — 15-minute guide
- SCOUT_DECISION_TREE.md — Choose implementation
- SCOUT_DEEP_DIVE.md — Technical details
- SCOUT_COMPLETE_SUMMARY.md — Full overview

Good luck! 🚀
