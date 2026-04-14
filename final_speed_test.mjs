import { solBalanceScoutV2 } from './sol_balance_scout_v2.mjs';
import { solBalanceScoutV3 } from './sol_balance_scout_v3.mjs';
import { spawn } from 'child_process';

const API_KEY = '10470584-67a9-49b4-90a4-1dee5f777761';
const WALLET = '54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs';

async function runRust() {
  return new Promise((resolve) => {
    let output = '';
    const proc = spawn('./sol_balance_scout_rust/target/release/sol_balance_scout', [WALLET, API_KEY]);
    proc.stdout.on('data', (d) => output += d);
    proc.stderr.on('data', (d) => output += d);
    proc.on('close', () => {
      try {
        const lines = output.split('\n');
        const jsonLine = JSON.parse(lines.find(l => l.includes('wallTimeMs')));
        resolve({ wallTimeMs: jsonLine.stats.wallTimeMs, samples: jsonLine.stats.sampleCount, rpcCalls: jsonLine.stats.totalRpcCalls });
      } catch {
        resolve({ error: 'parse' });
      }
    });
  });
}

async function main() {
  console.log('\n🚀 FINAL SPEED COMPARISON: Scout V2 vs V3 vs Rust\n');
  console.log('═'.repeat(70));
  
  const v2 = await solBalanceScoutV2(WALLET, API_KEY);
  console.log(`✅ Scout V2:   ${v2.stats.wallTimeMs.toFixed(0)}ms (${v2.stats.sampleCount} samples, ${v2.stats.totalRpcCalls} RPC calls)`);
  
  const v3 = await solBalanceScoutV3(WALLET, API_KEY);
  console.log(`✅ Scout V3:   ${v3.stats.wallTimeMs.toFixed(0)}ms (${v3.stats.sampleCount} samples, ${v3.stats.totalRpcCalls} RPC calls)`);
  
  const rust = await runRust();
  if (!rust.error) {
    console.log(`✅ Scout Rust: ${rust.wallTimeMs.toFixed(0)}ms (${rust.samples} samples, ${rust.rpcCalls} RPC calls)`);
  } else {
    console.log(`❌ Scout Rust: Failed to run`);
  }
  
  console.log('\n📊 SPEEDUP ANALYSIS\n');
  const v2Time = v2.stats.wallTimeMs;
  const v3Time = v3.stats.wallTimeMs;
  const rustTime = rust.wallTimeMs || v2Time;
  
  console.log(`V3 vs V2:   ${(v2Time/v3Time).toFixed(2)}x faster`);
  if (!rust.error) {
    console.log(`Rust vs V2: ${(v2Time/rustTime).toFixed(2)}x faster`);
    console.log(`Rust vs V3: ${(v3Time/rustTime).toFixed(2)}x faster`);
  }
  
  console.log('\n✨ WINNER: ' + (rustTime < v3Time && rustTime < v2Time ? 'Rust Scout 🏆' : v3Time < v2Time ? 'Scout V3' : 'Scout V2'));
  console.log('═'.repeat(70) + '\n');
}

main().catch(console.error);
