/**
 * Scenario 2: Webhook Simulation — "Alert me when wallet moves > X SOL"
 *
 * Polls the wallet's recent txs and fires an alert if any single native
 * transfer exceeds a threshold. Real prod version would register a Helius
 * webhook instead of polling.
 *
 * Helius REST: GET /v0/addresses/:address/transactions
 *
 * Usage: node scenario_webhook_sim.mjs <address> [api-key] [threshold-sol] [poll-interval-sec]
 */

const LAMPORTS = 1_000_000_000;
const DEFAULT_THRESHOLD_SOL = 1.0;
const DEFAULT_INTERVAL_SEC  = 15;

async function fetchRecent(address, apiKey, limit = 5) {
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function findLargeTransfers(txs, address, thresholdLamports) {
  const alerts = [];
  for (const tx of txs) {
    for (const nt of tx.nativeTransfers ?? []) {
      if (nt.amount < thresholdLamports) continue;
      const dir = nt.toUserAccount === address ? "IN" : nt.fromUserAccount === address ? "OUT" : null;
      if (!dir) continue;
      const sol = (nt.amount / LAMPORTS).toFixed(4);
      alerts.push({ sig: tx.signature, dir, sol, type: tx.type, ts: tx.timestamp });
    }
  }
  return alerts;
}

const address       = process.argv[2];
const apiKey        = process.argv[3] ?? process.env.HELIUS_API_KEY;
const thresholdSol  = parseFloat(process.argv[4] ?? DEFAULT_THRESHOLD_SOL);
const intervalSec   = parseInt(process.argv[5]   ?? DEFAULT_INTERVAL_SEC);

if (!address || !apiKey) {
  console.error("Usage: node scenario_webhook_sim.mjs <address> [api-key] [threshold-sol] [poll-sec]");
  process.exit(1);
}

const thresholdLamports = thresholdSol * LAMPORTS;
const seenSigs = new Set();
let polls = 0;

console.log(`Watching ${address}`);
console.log(`Alert threshold: ${thresholdSol} SOL | Poll every ${intervalSec}s | Ctrl-C to stop\n`);

async function poll() {
  polls++;
  const txs = await fetchRecent(address, apiKey);
  const alerts = findLargeTransfers(txs, address, thresholdLamports)
    .filter(a => !seenSigs.has(a.sig));

  for (const a of alerts) {
    seenSigs.add(a.sig);
    const date = new Date(a.ts * 1000).toISOString().slice(0, 19).replace("T", " ");
    console.log(`[ALERT] ${date}  ${a.dir.padEnd(4)} ${a.sol} SOL  type:${a.type}  sig:${a.sig.slice(0, 16)}…`);
  }

  if (alerts.length === 0 && polls % 4 === 0) {
    process.stdout.write(`[poll #${polls}] quiet\r`);
  }
}

await poll();
setInterval(poll, intervalSec * 1000);
