/**
 * Demo: scenario_enriched_tx.mjs
 *
 * Mocks the Helius /v0/addresses/:addr/transactions response so you can
 * see the output format without a live API key.
 *
 * Run: node demo_enriched_tx.mjs
 */

// ── Mock data — mirrors real Helius enriched tx shape ─────────────────────────
const MOCK_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const MOCK_TXS = [
  {
    signature: "5xK9mNpQrVt2wYjUoLbCdEfGhIkJlMnOpRsTuVwXyZaB",
    timestamp: 1712000000,
    type: "SWAP",
    source: "JUPITER",
    feePayer: MOCK_ADDRESS,
    nativeTransfers: [
      { fromUserAccount: MOCK_ADDRESS, toUserAccount: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", amount: 2_500_000_000 },
    ],
  },
  {
    signature: "3aB7cDe9FgH1iJkLmNoP2qRsT4uVwXyZ5AbCdEfGhIj",
    timestamp: 1712050000,
    type: "TRANSFER",
    source: "SYSTEM_PROGRAM",
    feePayer: "FriendWallet111111111111111111111111111111111",
    nativeTransfers: [
      { fromUserAccount: "FriendWallet111111111111111111111111111111111", toUserAccount: MOCK_ADDRESS, amount: 5_000_000_000 },
    ],
  },
  {
    signature: "7mNpQrVt2wYjUoLbCdEfGhIkJlMnOpRsTuVwXyZaB5x",
    timestamp: 1712100000,
    type: "NFT_SALE",
    source: "MAGIC_EDEN",
    feePayer: MOCK_ADDRESS,
    nativeTransfers: [
      { fromUserAccount: "BuyerWallet111111111111111111111111111111111", toUserAccount: MOCK_ADDRESS, amount: 12_000_000_000 },
      { fromUserAccount: MOCK_ADDRESS, toUserAccount: "RoyaltyWallet1111111111111111111111111111111", amount: 600_000_000 },
    ],
  },
  {
    signature: "2wYjUoLbCdEfGhIkJlMnOpRsTuVwXyZaB5x7mNpQrVt",
    timestamp: 1712150000,
    type: "STAKE_SOL",
    source: "MARINADE",
    feePayer: MOCK_ADDRESS,
    nativeTransfers: [
      { fromUserAccount: MOCK_ADDRESS, toUserAccount: "MarinadeStake11111111111111111111111111111111", amount: 10_000_000_000 },
    ],
  },
  {
    signature: "KlMnOpRsTuVwXyZaB5x7mNpQrVt2wYjUoLbCdEfGhIj",
    timestamp: 1712200000,
    type: "TRANSFER",
    source: "SYSTEM_PROGRAM",
    feePayer: MOCK_ADDRESS,
    nativeTransfers: [
      { fromUserAccount: MOCK_ADDRESS, toUserAccount: "RecipientWallet11111111111111111111111111111", amount: 1_000_000_000 },
    ],
  },
];

// ── Same formatting logic as scenario_enriched_tx.mjs ─────────────────────────
const LAMPORTS = 1_000_000_000;

function formatTx(tx) {
  const date = new Date(tx.timestamp * 1000).toISOString().slice(0, 19).replace("T", " ");
  const type = tx.type || "UNKNOWN";
  const source = tx.source || "?";

  const nativeIn  = (tx.nativeTransfers || []).filter(t => t.toUserAccount === MOCK_ADDRESS);
  const nativeOut = (tx.nativeTransfers || []).filter(t => t.fromUserAccount === MOCK_ADDRESS);

  const inSol  = nativeIn.reduce((s, t) => s + t.amount, 0) / LAMPORTS;
  const outSol = nativeOut.reduce((s, t) => s + t.amount, 0) / LAMPORTS;

  return `${date}  ${type.padEnd(20)} ${source.padEnd(16)} in:+${inSol.toFixed(4)}  out:-${outSol.toFixed(4)}  sig:${tx.signature.slice(0, 12)}…`;
}

// ── Run ────────────────────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║         DEMO: scenario_enriched_tx.mjs (mock data)          ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

console.log(`Wallet: ${MOCK_ADDRESS}\n`);

console.log("DATE (UTC)           TYPE                 SOURCE           IN (SOL)   OUT (SOL)  SIG");
console.log("─".repeat(100));

for (const tx of MOCK_TXS) console.log(formatTx(tx));

console.log(`\nTotal: ${MOCK_TXS.length} txs`);

console.log("\n── What's happening ────────────────────────────────────────────");
console.log("• SWAP/JUPITER:    wallet sent 2.5 SOL to Jupiter for a token swap");
console.log("• TRANSFER in:     friend sent 5 SOL to this wallet");
console.log("• NFT_SALE:        sold an NFT on Magic Eden, got 12 SOL, paid 0.6 royalty");
console.log("• STAKE_SOL:       staked 10 SOL into Marinade");
console.log("• TRANSFER out:    sent 1 SOL to someone");
console.log("\nTo run live: node scenario_enriched_tx.mjs <address> $HELIUS_API_KEY");
