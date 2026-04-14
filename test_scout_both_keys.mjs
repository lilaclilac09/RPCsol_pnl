import { solBalanceScoutV2 } from './sol_balance_scout_v2.mjs';
import { solBalanceScoutV3 } from './sol_balance_scout_v3.mjs';

const API_KEYS = [
  { name: 'Key 1', key: 'ba5bbc06-d3ee-42d4-bb60-6dfdb5ec3876' },
  { name: 'Key 2', key: '10470584-67a9-49b4-90a4-1dee5f777761' },
];

const TEST_WALLETS = [
  { address: '54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs', name: 'Sparse' },
  { address: '54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs', name: 'Medium' },
];

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🚀 SCOUT ALGORITHM MULTI-KEY BENCHMARK');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const apiKeyObj of API_KEYS) {
    console.log(`\n📊 Testing with ${apiKeyObj.name}\n`);
    
    for (const wallet of TEST_WALLETS) {
      console.log(`\n  ${wallet.name} Wallet`);
      console.log('  ' + '─'.repeat(50));
      
      try {
        // V2
        const startV2 = performance.now();
        const resultV2 = await solBalanceScoutV2(wallet.address, apiKeyObj.key);
        const timeV2 = resultV2.stats.wallTimeMs;
        
        console.log(`  ✅ Scout V2: ${timeV2.toFixed(0)}ms (${resultV2.stats.sampleCount} samples, ${resultV2.stats.totalRpcCalls} calls)`);
        
        // V3
        const startV3 = performance.now();
        const resultV3 = await solBalanceScoutV3(wallet.address, apiKeyObj.key);
        const timeV3 = resultV3.stats.wallTimeMs;
        
        console.log(`  ✅ Scout V3: ${timeV3.toFixed(0)}ms (${resultV3.stats.sampleCount} samples, ${resultV3.stats.totalRpcCalls} calls)`);
        
        // Comparison
        const speedup = timeV2 / timeV3;
        console.log(`  ⚡ V3 vs V2: ${speedup.toFixed(2)}x ${speedup > 1 ? '(V3 faster)' : '(V2 faster)'}`);
        
      } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
      }
    }
  }
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('✨ Benchmark Complete!');
  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
