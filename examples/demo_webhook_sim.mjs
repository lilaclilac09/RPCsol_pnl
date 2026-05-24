/**
 * Demo: scenario_webhook_sim.mjs
 *
 * Simulates 3 poll rounds with mocked API responses — one quiet round,
 * one with a large transfer alert, one with a small transfer (no alert).
 *
 * Run: node demo_webhook_sim.mjs
 */

const LAMPORTS = 1_000_000_000;
const THRESHOLD_SOL = 1.0;
const MOCK_ADDRESS  = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

// ── Simulated poll responses over time ────────────────────────────────────────
const POLL_ROUNDS = [
  // Round 1: no large transfers
  [
    {
      signature: "aaaa0000000000000000000000000000000000000000000000000000000000000000",
      timestamp: 1712000000,
      type: "TRANSFER",
      nativeTransfers: [
        { fromUserAccount: MOCK_ADDRESS, toUserAccount: "RecipientA", amount: 100_000_000 }, // 0.1 SOL — below threshold
      ],
    },
  ],
  // Round 2: large incoming transfer — triggers alert
  [
    {
      signature: "bbbb1111111111111111111111111111111111111111111111111111111111111111",
      timestamp: 1712050000,
      type: "TRANSFER",
      nativeTransfers: [
        { fromUserAccount: "FriendWallet", toUserAccount: MOCK_ADDRESS, amount: 5_500_000_000 }, // 5.5 SOL — ALERT
      ],
    },
    {
      signature: "aaaa0000000000000000000000000000000000000000000000000000000000000000", // already seen
      timestamp: 1712000000,
      type: "TRANSFER",
      nativeTransfers: [
        { fromUserAccount: MOCK_ADDRESS, toUserAccount: "RecipientA", amount: 100_000_000 },
      ],
    },
  ],
  // Round 3: large outgoing transfer — triggers alert
  [
    {
      signature: "cccc2222222222222222222222222222222222222222222222222222222222222222",
      timestamp: 1712100000,
      type: "SWAP",
      nativeTransfers: [
        { fromUserAccount: MOCK_ADDRESS, toUserAccount: "JupiterProgram", amount: 3_000_000_000 }, // 3 SOL out — ALERT
      ],
    },
    {
      signature: "bbbb1111111111111111111111111111111111111111111111111111111111111111",
      timestamp: 1712050000,
      type: "TRANSFER",
      nativeTransfers: [
        { fromUserAccount: "FriendWallet", toUserAccount: MOCK_ADDRESS, amount: 5_500_000_000 },
      ],
    },
  ],
];

// ── Same alert logic as scenario_webhook_sim.mjs ──────────────────────────────
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

// ── Simulate polling ──────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║        DEMO: scenario_webhook_sim.mjs (mock data)           ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

console.log(`Watching: ${MOCK_ADDRESS}`);
console.log(`Alert threshold: ${THRESHOLD_SOL} SOL | Simulating 3 poll rounds\n`);

const thresholdLamports = THRESHOLD_SOL * LAMPORTS;
const seenSigs = new Set();

for (let i = 0; i < POLL_ROUNDS.length; i++) {
  const txs    = POLL_ROUNDS[i];
  const alerts = findLargeTransfers(txs, MOCK_ADDRESS, thresholdLamports)
    .filter(a => !seenSigs.has(a.sig));

  console.log(`[poll #${i + 1}] checking ${txs.length} recent txs…`);

  if (alerts.length === 0) {
    console.log(`         quiet — no transfers above ${THRESHOLD_SOL} SOL\n`);
  } else {
    for (const a of alerts) {
      seenSigs.add(a.sig);
      const date = new Date(a.ts * 1000).toISOString().slice(0, 19).replace("T", " ");
      console.log(`  [ALERT] ${date}  ${a.dir.padEnd(4)} ${a.sol} SOL  type:${a.type}  sig:${a.sig.slice(0, 16)}…`);
    }
    console.log();
  }

  // small delay between simulated rounds for readability
  await new Promise(r => setTimeout(r, 300));
}

console.log("── What's happening ────────────────────────────────────────────");
console.log("• Poll 1: only a 0.1 SOL transfer — below threshold, silent");
console.log("• Poll 2: 5.5 SOL incoming — fires ALERT (new sig, not seen before)");
console.log("• Poll 3: 3.0 SOL swap out — fires ALERT; 5.5 SOL tx already seen, skipped");
console.log("\nTo run live (polls every 15s): node scenario_webhook_sim.mjs <address> $HELIUS_API_KEY 1.0 15");
