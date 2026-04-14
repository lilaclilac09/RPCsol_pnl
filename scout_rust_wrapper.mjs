/**
 * Scout Rust Wrapper
 * Calls the compiled Rust binary and returns structured results
 * 
 * Usage:
 *   import { solBalanceScoutRust } from './scout_rust_wrapper.mjs';
 *   const result = await solBalanceScoutRust(address, apiKey);
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUST_BINARY = path.join(__dirname, 'sol_balance_scout_rust/target/release/sol_balance_scout');

/**
 * Execute Scout Rust binary
 * @param {string} address - Solana address
 * @param {string} apiKey - Helius API key
 * @param {number} timeoutMs - Timeout in milliseconds (default 30000)
 * @returns {Promise<Object>} - Result with points, stats, and full output
 */
export async function solBalanceScoutRust(address, apiKey, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    let stdout = '';
    let stderr = '';

    const proc = spawn(RUST_BINARY, [address, apiKey], {
      timeout: timeoutMs,
      env: { ...process.env, HELIUS_API_KEY: apiKey },
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Scout Rust timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const totalTime = performance.now() - startTime;

      if (code === 0) {
        try {
          // Find JSON in output (should be at the end, after text output)
          const lines = stdout.split('\n');
          // Look for line starting with { (the JSON output)
          let jsonStr = '';
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].trim().startsWith('{')) {
              jsonStr = lines[i].trim();
              break;
            }
          }
          
          if (!jsonStr) {
            throw new Error('No JSON found in output');
          }

          // If it's partial, try to reconstruct from multiple lines
          if (!jsonStr.includes('}')) {
            jsonStr = lines.slice(Math.max(0, lines.findIndex(l => l.includes('{')))).join('\n');
          }

          const result = JSON.parse(jsonStr);

          resolve({
            points: result.points || 0,
            balance: result.closing_balance_lamports || 0,
            stats: {
              totalRpcCalls: result.stats.totalRpcCalls,
              wallTimeMs: result.stats.wallTimeMs,
              sampleCount: result.stats.sampleCount,
              phase0Calls: result.stats.phase0Calls,
              phase1Calls: result.stats.phase1Calls,
              phase2Calls: result.stats.phase2Calls,
            },
            fullOutput: stdout,
            success: true,
          });
        } catch (e) {
          reject(new Error(`Failed to parse Scout Rust output: ${e.message}`));
        }
      } else {
        reject(new Error(`Scout Rust exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Check if Rust binary exists and is executable
 */
export function isRustBinaryAvailable() {
  try {
    return fs.existsSync(RUST_BINARY) && fs.statSync(RUST_BINARY).isFile();
  } catch {
    return false;
  }
}

/**
 * Get Rust binary path for direct use
 */
export function getRustBinaryPath() {
  return RUST_BINARY;
}
