#!/usr/bin/env node
/**
 * Scout Algorithm: Multi-Implementation Benchmarking Suite
 * 
 * Runs all three Scout implementations (V2, V3, Rust) against the same wallets
 * and produces a comprehensive comparison report.
 * 
 * Usage:
 *   node bench_scout_all.mjs [OPTIONS]
 * 
 * Options:
 *   --wallets address1,address2,...  (default: test wallets)
 *   --api-key KEY                     (default: HELIUS_API_KEY env var)
 *   --rust                            (include Rust binary, if built)
 *   --verbose                         (show detailed timing breakdown)
 * 
 * Example:
 *   HELIUS_API_KEY=your-key node bench_scout_all.mjs --rust --verbose
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================

const TEST_WALLETS = [
  '9B5X4jNGU8R6cVvAMbmF1D8HZYQ3Dax2z7w5X2E9z3w8J',  // sparse
  'DuL5kGLbZ6J4w2X9z5X2E8F9G3H4K5L9Z6Q3W2N8X5Z2',  // medium
  'EPjFWaJPgqEfRWfWwqxNvxMbWjvWTx3P8xX8fZ9z5X2E9z'  // dense
];

const TIMEOUT_MS = 60000;  // 60 seconds per implementation
const VERBOSE = process.argv.includes('--verbose');
const INCLUDE_RUST = process.argv.includes('--rust');
const API_KEY = process.argv.includes('--api-key') 
  ? process.argv[process.argv.indexOf('--api-key') + 1]
  : process.env.HELIUS_API_KEY;

if (!API_KEY) {
  console.error('❌ Error: HELIUS_API_KEY environment variable not set');
  console.error('   Set it: export HELIUS_API_KEY=your-key');
  process.exit(1);
}

// ============================================================================
// COLOR OUTPUT
// ============================================================================

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const log = (msg, color = 'reset') => {
  console.log(`${COLORS[color]}${msg}${COLORS.reset}`);
};

const section = (title) => {
  log(`\n${'='.repeat(80)}`, 'bright');
  log(`  ${title}`, 'bright');
  log(`${'='.repeat(80)}`, 'bright');
};

const subsection = (title) => {
  log(`\n${title}`, 'cyan');
  log('-'.repeat(title.length), 'cyan');
};

// ============================================================================
// TEST RUNNER
// ============================================================================

async function runScoutV2(address, apiKey) {
  const { solBalanceScoutV2 } = await import('./sol_balance_scout_v2.mjs');
  
  const startTime = performance.now();
  try {
    const result = await solBalanceScoutV2(address, apiKey);
    const endTime = performance.now();
    
    return {
      success: true,
      points: result.points || 0,
      wallTimeMs: Math.round(endTime - startTime),
      rpcCalls: result.stats?.totalRpcCalls || 0,
      sampleCount: result.stats?.sampleCount || 0,
      error: null,
      implementation: 'V2',
    };
  } catch (error) {
    const endTime = performance.now();
    return {
      success: false,
      wallTimeMs: Math.round(endTime - startTime),
      error: error.message,
      implementation: 'V2',
    };
  }
}

async function runScoutV3(address, apiKey) {
  const { solBalanceScoutV3 } = await import('./sol_balance_scout_v3.mjs');
  
  const startTime = performance.now();
  try {
    const result = await solBalanceScoutV3(address, apiKey);
    const endTime = performance.now();
    
    return {
      success: true,
      points: result.points || 0,
      wallTimeMs: Math.round(endTime - startTime),
      rpcCalls: result.stats?.totalRpcCalls || 0,
      sampleCount: result.stats?.sampleCount || 0,
      error: null,
      implementation: 'V3',
    };
  } catch (error) {
    const endTime = performance.now();
    return {
      success: false,
      wallTimeMs: Math.round(endTime - startTime),
      error: error.message,
      implementation: 'V3',
    };
  }
}

async function runScoutRust(address, apiKey) {
  const rustBinary = path.join(__dirname, 'sol_balance_scout_rust/target/release/sol_balance_scout');
  
  if (!fs.existsSync(rustBinary)) {
    return {
      success: false,
      error: 'Rust binary not found. Build with: cd sol_balance_scout_rust && cargo build --release',
      implementation: 'Rust',
    };
  }
  
  return new Promise((resolve) => {
    const startTime = performance.now();
    let output = '';
    let errorOutput = '';
    
    const process = spawn(rustBinary, [address], {
      env: { ...process.env, HELIUS_API_KEY: apiKey },
      timeout: TIMEOUT_MS,
    });
    
    process.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    process.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    process.on('close', (code) => {
      const endTime = performance.now();
      
      if (code === 0) {
        try {
          // Extract JSON from output (last line)
          const lines = output.trim().split('\n');
          const jsonLine = lines.find(l => l.includes('"wallet"'));
          const data = JSON.parse(jsonLine || output);
          
          resolve({
            success: true,
            points: data.points || 0,
            wallTimeMs: Math.round(endTime - startTime),
            rpcCalls: data.stats?.total_rpc_calls || 0,
            sampleCount: data.stats?.sample_count || 0,
            error: null,
            implementation: 'Rust',
          });
        } catch (e) {
          resolve({
            success: false,
            wallTimeMs: Math.round(endTime - startTime),
            error: `Parse error: ${e.message}`,
            implementation: 'Rust',
          });
        }
      } else {
        resolve({
          success: false,
          wallTimeMs: Math.round(endTime - startTime),
          error: errorOutput || `Process exited with code ${code}`,
          implementation: 'Rust',
        });
      }
    });
    
    process.on('error', (err) => {
      resolve({
        success: false,
        wallTimeMs: Math.round(performance.now() - startTime),
        error: err.message,
        implementation: 'Rust',
      });
    });
  });
}

// ============================================================================
// REPORTING
// ============================================================================

function formatWalletKey(address) {
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function speedupString(baseMs, testMs) {
  if (!baseMs || !testMs || baseMs === 0) return 'N/A';
  const speedup = baseMs / testMs;
  return `${speedup.toFixed(2)}x`;
}

function formatTime(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatNumberRight(num) {
  return String(num).padStart(8, ' ');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  section('🚀 SCOUT ALGORITHM BENCHMARKING SUITE');
  
  log(`Test wallets: ${TEST_WALLETS.length}`, 'cyan');
  log(`API key: ${API_KEY.slice(0, 8)}...`, 'dim');
  log(`Include Rust: ${INCLUDE_RUST}`, 'dim');
  
  const results = {}; // { wallet: { V2: {...}, V3: {...}, Rust: {...} } }
  
  // Test each wallet
  for (const wallet of TEST_WALLETS) {
    subsection(`Testing ${formatWalletKey(wallet)}`);
    
    results[wallet] = {};
    
    // V2
    log(`  Running Scout V2...`, 'yellow');
    const v2Result = await runScoutV2(wallet, API_KEY);
    results[wallet].V2 = v2Result;
    if (v2Result.success) {
      log(`    ✅ ${formatTime(v2Result.wallTimeMs)} (${v2Result.sampleCount} samples, ${v2Result.rpcCalls} RPC calls)`, 'green');
    } else {
      log(`    ❌ ${v2Result.error}`, 'red');
    }
    
    // V3
    log(`  Running Scout V3...`, 'yellow');
    const v3Result = await runScoutV3(wallet, API_KEY);
    results[wallet].V3 = v3Result;
    if (v3Result.success) {
      const v3Speedup = speedupString(v2Result.wallTimeMs, v3Result.wallTimeMs);
      log(`    ✅ ${formatTime(v3Result.wallTimeMs)} (${v3Result.sampleCount} samples, ${v3Result.rpcCalls} RPC calls) [${v3Speedup} vs V2]`, 'green');
    } else {
      log(`    ❌ ${v3Result.error}`, 'red');
    }
    
    // Rust (if requested)
    if (INCLUDE_RUST) {
      log(`  Running Scout Rust...`, 'yellow');
      const rustResult = await runScoutRust(wallet, API_KEY);
      results[wallet].Rust = rustResult;
      if (rustResult.success) {
        const rustSpeedupVsV2 = speedupString(v2Result.wallTimeMs, rustResult.wallTimeMs);
        const rustSpeedupVsV3 = speedupString(v3Result.wallTimeMs, rustResult.wallTimeMs);
        log(`    ✅ ${formatTime(rustResult.wallTimeMs)} (${rustResult.sampleCount} samples, ${rustResult.rpcCalls} RPC calls)`, 'green');
        log(`       Speedup vs V2: ${rustSpeedupVsV2}, vs V3: ${rustSpeedupVsV3}`, 'blue');
      } else {
        log(`    ❌ ${rustResult.error}`, 'red');
      }
    }
  }
  
  // Summary table
  section('📊 SUMMARY TABLE');
  
  const header = ['Address', 'V2 Time', 'V3 Time', 'V3 vs V2', ...(INCLUDE_RUST ? ['Rust Time', 'Rust vs V2'] : [])];
  log(header.map((h, i) => i === 0 ? h.padEnd(20) : h.padStart(12)).join(' '), 'cyan');
  log(header.map((h, i) => i === 0 ? '─'.repeat(20) : '─'.repeat(12)).join(' '), 'cyan');
  
  for (const wallet of TEST_WALLETS) {
    const v2 = results[wallet].V2;
    const v3 = results[wallet].V3;
    const rust = INCLUDE_RUST ? results[wallet].Rust : null;
    
    const cells = [
      formatWalletKey(wallet).padEnd(20),
      (v2.success ? formatTime(v2.wallTimeMs) : 'ERROR').padStart(12),
      (v3.success ? formatTime(v3.wallTimeMs) : 'ERROR').padStart(12),
      (v2.success && v3.success ? speedupString(v2.wallTimeMs, v3.wallTimeMs) : 'N/A').padStart(12),
    ];
    
    if (INCLUDE_RUST) {
      cells.push((rust.success ? formatTime(rust.wallTimeMs) : 'ERROR').padStart(12));
      cells.push((v2.success && rust.success ? speedupString(v2.wallTimeMs, rust.wallTimeMs) : 'N/A').padStart(12));
    }
    
    log(cells.join(' '));
  }
  
  // Statistics
  section('📈 STATISTICS');
  
  const v2Times = TEST_WALLETS.map(w => results[w].V2.wallTimeMs).filter(t => t > 0);
  const v3Times = TEST_WALLETS.map(w => results[w].V3.wallTimeMs).filter(t => t > 0);
  const rustTimes = INCLUDE_RUST ? TEST_WALLETS.map(w => results[w].Rust?.wallTimeMs).filter(t => t > 0) : [];
  
  const stats = (times, label) => {
    if (times.length === 0) return;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const avg = Math.round(times.reduce((a, b) => a + b) / times.length);
    log(`${label}:`, 'cyan');
    log(`  Min: ${formatTime(min)}, Max: ${formatTime(max)}, Avg: ${formatTime(avg)}`);
  };
  
  stats(v2Times, 'Scout V2');
  stats(v3Times, 'Scout V3');
  if (INCLUDE_RUST) stats(rustTimes, 'Scout Rust');
  
  const v3AvgSpeedup = v2Times.length > 0 && v3Times.length > 0
    ? (v2Times.reduce((a, b) => a + b) / v2Times.length) / (v3Times.reduce((a, b) => a + b) / v3Times.length)
    : 0;
  
  log(`\nAverage Speedup (V3 vs V2): ${v3AvgSpeedup.toFixed(2)}x`, 'green');
  
  if (INCLUDE_RUST && rustTimes.length > 0) {
    const rustAvgSpeedup = (v2Times.reduce((a, b) => a + b) / v2Times.length) / (rustTimes.reduce((a, b) => a + b) / rustTimes.length);
    log(`Average Speedup (Rust vs V2): ${rustAvgSpeedup.toFixed(2)}x`, 'green');
  }
  
  // Recommendations
  section('✅ RECOMMENDATIONS');
  
  const allV3Faster = TEST_WALLETS.every(w => 
    results[w].V3.success && results[w].V2.success && 
    results[w].V3.wallTimeMs < results[w].V2.wallTimeMs
  );
  
  if (allV3Faster && v3AvgSpeedup > 1.15) {
    log('✓ Use Scout V3: Consistently faster than V2 (>15% improvement)', 'green');
  } else {
    log('✓ Scout V2 sufficient: Good performance, simpler algorithm', 'green');
  }
  
  if (INCLUDE_RUST && results[TEST_WALLETS[0]].Rust?.success) {
    const rustAvg = rustTimes.length > 0 
      ? rustTimes.reduce((a, b) => a + b) / rustTimes.length 
      : 0;
    const v2Avg = v2Times.reduce((a, b) => a + b) / v2Times.length;
    const rustSpeedup = v2Avg / rustAvg;
    
    if (rustSpeedup > 2.0) {
      log(`✓ Scout Rust highly recommended: ${rustSpeedup.toFixed(2)}x faster for production`, 'green');
    } else if (rustSpeedup > 1.3) {
      log(`✓ Scout Rust beneficial: ${rustSpeedup.toFixed(2)}x faster, consider for production`, 'blue');
    } else {
      log(`✓ Scout Rust viable: ${rustSpeedup.toFixed(2)}x faster, marginal improvement`, 'yellow');
    }
  }
  
  log('\nFor integration guidance, see SCOUT_DECISION_TREE.md', 'dim');
  
  section('✨ DONE');
}

main().catch(error => {
  log(`\n❌ Fatal error: ${error.message}`, 'red');
  process.exit(1);
});
