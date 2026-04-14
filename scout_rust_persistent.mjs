// scout_rust_persistent.mjs - Reuse single Rust process
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const BINARY_PATH = path.resolve('./sol_balance_scout_rust/target/release/sol_balance_scout');
let process = null;
let requestQueue = [];
let isReady = false;

// Start the Rust process once
function startProcess() {
  return new Promise((resolve, reject) => {
    try {
      process = spawn(BINARY_PATH, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });

      process.stdout.on('data', (data) => {
        console.log(`[Rust stdout] ${data.toString()}`);
      });

      process.stderr.on('data', (data) => {
        console.error(`[Rust stderr] ${data.toString()}`);
      });

      process.on('error', (err) => {
        console.error('Process error:', err);
        process = null;
        isReady = false;
      });

      // Assume ready after 500ms startup
      setTimeout(() => {
        isReady = true;
        resolve();
      }, 500);
    } catch (err) {
      reject(err);
    }
  });
}

// Request to persistent process with stdin/stdout protocol
async function queryPersistentRust(address, apiKey) {
  return new Promise((resolve, reject) => {
    if (!process || !isReady) {
      reject(new Error('Rust process not ready'));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for Rust response'));
    }, 5000);

    let output = '';
    const dataHandler = (data) => {
      output += data.toString();

      // Look for complete JSON response (ends with })
      const lines = output.split('\n');
      const jsonLine = lines.find(line => line.trim().startsWith('{'));

      if (jsonLine) {
        process.stdout.removeListener('data', dataHandler);
        clearTimeout(timeout);

        try {
          const json = JSON.parse(jsonLine);
          resolve(json);
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${jsonLine}`));
        }
      }
    };

    process.stdout.on('data', dataHandler);

    // Send request via stdin: "ADDRESS API_KEY\n"
    process.stdin.write(`${address} ${apiKey}\n`);
  });
}

// Public API
export async function initialize() {
  await startProcess();
  console.log('✅ Rust process started (persistent)');
}

export async function solBalanceScoutRustPersistent(address, apiKey, options = {}) {
  const startTime = Date.now();

  try {
    const result = await queryPersistentRust(address, apiKey);
    const latencyMs = Date.now() - startTime;

    return {
      ...result,
      stats: {
        ...result.stats,
        wallTimeMs: latencyMs,
      },
      success: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stats: { wallTimeMs: Date.now() - startTime },
    };
  }
}

export async function cleanup() {
  if (process) {
    process.kill();
    process = null;
    isReady = false;
  }
}

// Test
if (import.meta.url === `file://${process.argv[1]}`) {
  await initialize();

  const address = '54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs';
  const apiKey = process.env.HELIUS_API_KEY;

  console.log('\n🧪 Testing persistent Rust (5 sequential calls):');
  for (let i = 1; i <= 5; i++) {
    console.log(`\n  Call ${i}...`);
    const start = Date.now();
    const result = await solBalanceScoutRustPersistent(address, apiKey);
    const elapsed = Date.now() - start;
    console.log(`  ✅ ${elapsed}ms latency`);
  }

  await cleanup();
  console.log('\n✅ Persistent mode test complete');
}
