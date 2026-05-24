# ✅ Scout Algorithm Package Verification

Run this checklist to verify all Scout files are in place and ready to use.

---

## 📋 File Inventory Checklist

### Documentation Files (6 required)

```bash
# Run this to verify all docs exist:
ls -1 SCOUT_*.md

# Expected output:
# SCOUT_COMPLETE_SUMMARY.md
# SCOUT_DEEP_DIVE.md
# SCOUT_DECISION_TREE.md
# SCOUT_IMPLEMENTATIONS_GUIDE.md
# SCOUT_INTEGRATION_GUIDE.md
# SCOUT_README.md (master index)
# SCOUT_QUICK_START.md
```

### JavaScript Implementation Files (3 required)

```bash
ls -1 sol_balance_scout_*.mjs

# Expected output:
# sol_balance_scout.mjs
# sol_balance_scout_v2.mjs
# sol_balance_scout_v3.mjs
```

### Benchmarking Files (2 required)

```bash
ls -1 bench_scout*.mjs

# Expected output:
# bench_scout_all.mjs
# bench_scout_v2.mjs
```

### Rust Implementation (1 directory)

```bash
ls -l sol_balance_scout_rust/

# Expected output:
# Cargo.toml
# src/
#   algorithm.rs
#   lib.rs
#   main.rs
#   rpc.rs
#   types.rs
# target/ (after building)
```

---

## ✨ Quick Verification Script

Run this to verify everything at once:

```bash
#!/bin/bash

echo "🔍 Scout Algorithm Package Verification"
echo ""

# Counter
total=0
found=0

# Check documentation
echo "📚 Documentation files:"
for file in SCOUT_README.md SCOUT_DECISION_TREE.md SCOUT_QUICK_START.md \
            SCOUT_INTEGRATION_GUIDE.md SCOUT_DEEP_DIVE.md \
            SCOUT_IMPLEMENTATIONS_GUIDE.md SCOUT_COMPLETE_SUMMARY.md; do
  total=$((total + 1))
  if [ -f "$file" ]; then
    echo "  ✅ $file"
    found=$((found + 1))
  else
    echo "  ❌ $file (missing)"
  fi
done

echo ""
echo "🛠️  JavaScript implementations:"
for file in sol_balance_scout_v2.mjs sol_balance_scout_v3.mjs sol_balance_scout.mjs; do
  total=$((total + 1))
  if [ -f "$file" ]; then
    echo "  ✅ $file"
    found=$((found + 1))
  else
    echo "  ❌ $file (missing)"
  fi
done

echo ""
echo "📊 Benchmarking tools:"
for file in bench_scout_v2.mjs bench_scout_all.mjs; do
  total=$((total + 1))
  if [ -f "$file" ]; then
    echo "  ✅ $file"
    found=$((found + 1))
  else
    echo "  ❌ $file (missing)"
  fi
done

echo ""
echo "🦀 Rust implementation:"
if [ -d "sol_balance_scout_rust" ]; then
  total=$((total + 1))
  found=$((found + 1))
  echo "  ✅ sol_balance_scout_rust/"
  
  # Check Rust files
  for file in Cargo.toml src/main.rs src/lib.rs src/types.rs src/rpc.rs src/algorithm.rs; do
    if [ -f "sol_balance_scout_rust/$file" ]; then
      echo "    ✅ $file"
    else
      echo "    ❌ $file (missing)"
    fi
  done
else
  echo "  ❌ sol_balance_scout_rust/ (missing)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Summary: $found/$total files found"

if [ $found -eq $total ]; then
  echo "✅ All files present! Ready to use."
  exit 0
else
  echo "❌ Some files missing. Run git pull or verify installation."
  exit 1
fi
```

---

## 🧪 Functional Verification

After checking files, verify each implementation is functional:

### 1. Test Scout V2

```bash
export HELIUS_API_KEY=your-key
node -e "
import('./sol_balance_scout_v2.mjs').then(m => {
  console.log('✅ sol_balance_scout_v2.mjs imports successfully');
  console.log('   Function available:', typeof m.solBalanceScoutV2);
}).catch(e => {
  console.error('❌ Import failed:', e.message);
});
"
```

**Expected output:**
```
✅ sol_balance_scout_v2.mjs imports successfully
   Function available: function
```

### 2. Test Scout V3

```bash
node -e "
import('./sol_balance_scout_v3.mjs').then(m => {
  console.log('✅ sol_balance_scout_v3.mjs imports successfully');
  console.log('   Function available:', typeof m.solBalanceScoutV3);
}).catch(e => {
  console.error('❌ Import failed:', e.message);
});
"
```

### 3. Test Benchmarking Suite

```bash
export HELIUS_API_KEY=your-key
node -e "
import('./bench_scout_v2.mjs').then(() => {
  console.log('✅ bench_scout_v2.mjs syntax correct');
}).catch(e => {
  console.error('❌ Syntax error:', e.message);
});
"
```

### 4. Test Rust Project Structure

```bash
cd sol_balance_scout_rust

# Check Cargo.toml
if grep -q 'name = "sol_balance_scout"' Cargo.toml; then
  echo "✅ Cargo.toml configured correctly"
else
  echo "❌ Cargo.toml not configured"
fi

# Check main dependencies
for dep in tokio reqwest serde futures; do
  if grep -q "^$dep" Cargo.toml; then
    echo "✅ Dependency: $dep"
  else
    echo "⚠️  Missing dependency: $dep"
  fi
done

cd ..
```

---

## 🚀 Pre-Flight Checklist

Before starting benchmarking, verify:

### Environment

```bash
# ✅ Check: Environment variable set
echo "API Key set: ${HELIUS_API_KEY:-(not set)}"

# ✅ Check: Node.js version (need 18+)
node --version  # Should show v18.0.0 or higher

# ✅ Check: npm available (for potential dependencies)
npm --version

# ✅ Check: Rust toolchain (if planning to use Rust)
rustc --version
cargo --version
```

### Documentation

```bash
# ✅ Check: Can you read the decision guide?
head -20 SCOUT_DECISION_TREE.md

# ✅ Check: Quick start available?
wc -l SCOUT_QUICK_START.md  # Should be 200+ lines

# ✅ Check: Integration guide present?
grep -l "eval_scout" SCOUT_INTEGRATION_GUIDE.md  # Should find content
```

### JavaScript Implementations

```bash
# ✅ Check: V2 has solBalanceScoutV2 export
grep "export.*solBalanceScoutV2" sol_balance_scout_v2.mjs

# ✅ Check: V3 has solBalanceScoutV3 export
grep "export.*solBalanceScoutV3" sol_balance_scout_v3.mjs

# ✅ Check: Benchmark can reference V15
grep "solBalanceV15\|eval_v15" bench_scout_v2.mjs
```

---

## 🎯 Quick Start After Verification

Once verified, run in order:

### Step 1: Choose Implementation (2 minutes)

```bash
# Read the decision guide
head -30 SCOUT_DECISION_TREE.md

# Recommendation: Start with Scout V2
```

### Step 2: Run Benchmark (5 minutes)

```bash
export HELIUS_API_KEY=your-key

# Quick test
time node bench_scout_v2.mjs

# Expected: "Speedup: 1.5x - 2.5x" ✓
```

### Step 3: Review Results (2 minutes)

```bash
# Check output for:
# 1. Speedup >= 1.5x?
# 2. All wallets completed?
# 3. Sample count matches?
# 4. No 429 errors?

# If YES to all → Ready to integrate!
# If NO → Check SCOUT_QUICK_START.md troubleshooting
```

### Step 4: Integrate (5-10 minutes)

```bash
# Follow integration guide
grep -A 20 "Create eval_scout_v2" SCOUT_INTEGRATION_GUIDE.md

# Create your eval file (templates provided)
# Add to your coordinator/test suite
# Run your full test pipeline
```

---

## 🔧 Troubleshooting During Verification

### Issue: "Module not found" error

**Check:** Is the file in the right directory?
```bash
ls -la sol_balance_scout_v2.mjs  # Should exist
```

**Fix:** Ensure all files are in your project root, not a subdirectory.

### Issue: "HELIUS_API_KEY not set" error

**Check:** Is environment variable exported?
```bash
echo $HELIUS_API_KEY  # Should print your key
```

**Fix:** Export it first
```bash
export HELIUS_API_KEY=your-api-key-here
```

### Issue: "solBalanceV15 is not defined" in bench_scout_v2.mjs

**Check:** Does eval_v15.mjs exist in your project?
```bash
ls eval_v15.mjs  # Should exist
```

**Fix:** Ensure eval_v15.mjs is in same directory, or update import path in bench_scout_v2.mjs

### Issue: Rust binary won't build

**Check:** Is Rust installed?
```bash
rustc --version
cargo --version
```

**Fix:** Install from https://rustup.rs/
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

---

## 📊 Verification Success Criteria

You're good to go if:

- [ ] All 13+ files present (7 docs + 3 JS impls + 2 bench + 1 Rust dir)
- [ ] All JS files import without errors
- [ ] Rust project structure intact (Cargo.toml + 6 src files)
- [ ] HELIUS_API_KEY environment variable set
- [ ] Node.js version >= 18.0.0
- [ ] Can read all documentation files
- [ ] bench_scout_v2.mjs runs without syntax errors

---

## ✨ Next Steps After Verification

**If verification passes:**
1. Read SCOUT_DECISION_TREE.md (choose implementation)
2. Run SCOUT_QUICK_START.md (get immediate results)
3. Follow SCOUT_INTEGRATION_GUIDE.md (integrate into test suite)

**If verification fails:**
1. Check troubleshooting above
2. Verify git clone/download was complete
3. Run verification again
4. Contact support if issues persist

---

## 🎉 You're Ready!

Once verification passes, you have:

- ✅ 3 Scout implementations ready to test
- ✅ Automatic benchmarking tools
- ✅ Complete Rust version for production
- ✅ 7 comprehensive guides
- ✅ Integration templates for EvoHarness
- ✅ Everything needed for 1.5-4x speedup

**Expected timeline:**
- **Today:** Verify + choose implementation (15 min)
- **This week:** Integration + benchmarking (1-2 hours)
- **Next week:** Production deployment (varies)

Good luck! 🚀
