/**
 * Scout Rust Evaluator for EvoHarness
 * 
 * Evaluates wallet balance lookups using the Rust Scout algorithm
 * Integrates with GBrain for automatic result storage
 * 
 * Usage:
 *   import { evaluateScoutRust } from './eval_scout_rust.mjs';
 *   
 *   const result = await evaluateScoutRust(['ADDRESS1', 'ADDRESS2'], {
 *     iterations: 5,
 *     apiKey: 'your-key',
 *     gbrain: gbrain  // optional GBrain instance
 *   });
 */

import { solBalanceScoutRust } from './scout_rust_wrapper.mjs';

/**
 * Evaluate Scout Rust on multiple wallets
 * @param {string[]} wallets - Array of Solana addresses
 * @param {Object} options - Configuration
 * @param {number} options.iterations - Iterations per wallet (default 3)
 * @param {string} options.apiKey - Helius API key (required)
 * @param {Object} options.gbrain - GBrain instance for storage (optional)
 * @returns {Promise<Object>} - Score and detailed results
 */
export async function evaluateScoutRust(wallets, options = {}) {
  const {
    iterations = 3,
    apiKey,
    gbrain = null,
  } = options;

  if (!apiKey) {
    throw new Error('apiKey required for Scout Rust evaluation');
  }

  if (!wallets || wallets.length === 0) {
    throw new Error('At least one wallet required');
  }

  console.log(`🚀 Evaluating Scout Rust on ${wallets.length} wallet(s)`);
  console.log(`   Iterations: ${iterations}`);
  console.log(`   Total runs: ${wallets.length * iterations}\n`);

  let totalScore = 0;
  let successCount = 0;
  const results = [];
  const walletResults = {};

  for (const wallet of wallets) {
    walletResults[wallet] = {
      iterations: [],
      avgLatency: 0,
      avgScore: 0,
      rpcCalls: 0,
      sampleCount: 0,
    };

    for (let i = 0; i < iterations; i++) {
      try {
        const result = await solBalanceScoutRust(wallet, apiKey);

        // Score formula: 10 / (1 + latency_seconds)
        const latencySeconds = result.stats.wallTimeMs / 1000;
        const score = 10 / (1 + latencySeconds);

        walletResults[wallet].iterations.push({
          iteration: i + 1,
          latencyMs: result.stats.wallTimeMs,
          score: score,
          rpcCalls: result.stats.totalRpcCalls,
          samples: result.stats.sampleCount,
          success: true,
        });

        walletResults[wallet].avgLatency += result.stats.wallTimeMs;
        walletResults[wallet].avgScore += score;
        walletResults[wallet].rpcCalls = result.stats.totalRpcCalls;
        walletResults[wallet].sampleCount = result.stats.sampleCount;
        totalScore += score;
        successCount++;

        // Store in GBrain if available
        if (gbrain) {
          try {
            await gbrain.ingest({
              type: 'scout_rust_result',
              wallet,
              iteration: i + 1,
              latencyMs: result.stats.wallTimeMs,
              score: score,
              timestamp: new Date().toISOString(),
            });
          } catch (e) {
            // Silently fail GBrain ingestion
            if (process.env.DEBUG) console.warn(`GBrain ingest failed: ${e.message}`);
          }
        }

        console.log(
          `  ✅ ${wallet.slice(0, 8)}...${wallet.slice(-4)} [${i + 1}/${iterations}]: ${result.stats.wallTimeMs}ms (score: ${score.toFixed(2)})`
        );
      } catch (error) {
        walletResults[wallet].iterations.push({
          iteration: i + 1,
          error: error.message,
          success: false,
        });

        console.log(
          `  ❌ ${wallet.slice(0, 8)}...${wallet.slice(-4)} [${i + 1}/${iterations}]: ${error.message}`
        );
      }
    }

    // Calculate wallet averages
    if (walletResults[wallet].iterations.some(r => r.success)) {
      const successIter = walletResults[wallet].iterations.filter(r => r.success);
      walletResults[wallet].avgLatency /= successIter.length;
      walletResults[wallet].avgScore /= successIter.length;
    }
  }

  const finalScore = successCount > 0 ? totalScore / successCount : 0;

  console.log(`\n📊 RESULTS`);
  console.log('═'.repeat(60));
  console.log(`Success rate: ${successCount}/${wallets.length * iterations} (${((successCount / (wallets.length * iterations)) * 100).toFixed(1)}%)`);
  console.log(`Average score: ${finalScore.toFixed(3)} (target >= 8.0)`);
  console.log(`Average latency: ${(wallets.reduce((acc, w) => acc + walletResults[w].avgLatency, 0) / wallets.length).toFixed(0)}ms`);

  return {
    score: finalScore,
    implementation: 'Scout Rust',
    timestamp: new Date().toISOString(),
    config: {
      iterations,
      walletCount: wallets.length,
      totalRuns: wallets.length * iterations,
    },
    stats: {
      successCount,
      failureCount: wallets.length * iterations - successCount,
      successRate: successCount / (wallets.length * iterations),
    },
    walletResults,
    details: walletResults,
  };
}

/**
 * Get search space for EvoHarness parameter evolution
 * Returns parameter ranges for automated tuning
 */
export function getSearchSpace() {
  // Rust binary doesn't have tunable parameters,
  // but this shows the interface for EvoHarness compatibility
  return {
    // All parameters are fixed in Rust for now
    // Could be extended with environment variables if needed
  };
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG = {
  iterations: 3,
  timeoutMs: 30000,
};
