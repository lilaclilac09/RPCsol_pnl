/**
 * Demo: scenario_portfolio_snapshot.mjs
 *
 * Mocks the DAS getAssetsByOwner response + getBalance so you can see
 * what a real portfolio snapshot output looks like without an API key.
 *
 * Run: node demo_portfolio_snapshot.mjs
 */

const LAMPORTS = 1_000_000_000;
const MOCK_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

// ── Mock native SOL balance ────────────────────────────────────────────────────
const MOCK_SOL_LAMPORTS = 14_237_840_000; // ~14.24 SOL

// ── Mock DAS getAssetsByOwner fungible token response ─────────────────────────
// Each item mirrors the real Helius DAS shape
const MOCK_ASSETS = [
  {
    interface: "FungibleToken",
    content: { metadata: { symbol: "USDC" } },
    token_info: {
      balance: 5_432_100_000,   // raw, decimals=6 → 5432.10 USDC
      decimals: 6,
      price_info: { price_per_token: 1.00 },
    },
  },
  {
    interface: "FungibleToken",
    content: { metadata: { symbol: "JUP" } },
    token_info: {
      balance: 1_200_000_000_000, // raw, decimals=6 → 1,200,000 JUP
      decimals: 6,
      price_info: { price_per_token: 0.00082 },
    },
  },
  {
    interface: "FungibleToken",
    content: { metadata: { symbol: "BONK" } },
    token_info: {
      balance: 8_750_000_000_000_000, // raw, decimals=5 → 87,500,000,000 BONK
      decimals: 5,
      price_info: { price_per_token: 0.0000000148 },
    },
  },
  {
    interface: "FungibleAsset",
    content: { metadata: { symbol: "mSOL" } },
    token_info: {
      balance: 9_870_000_000,  // raw, decimals=9 → 9.87 mSOL
      decimals: 9,
      price_info: { price_per_token: 195.30 },
    },
  },
  {
    interface: "FungibleToken",
    content: { metadata: { symbol: "DUST" } },
    token_info: {
      balance: 50_000_000,   // raw, decimals=9 → 0.05 — tiny, still shown
      decimals: 9,
      price_info: null,      // no price data available
    },
  },
];

// ── Same formatting logic as scenario_portfolio_snapshot.mjs ──────────────────
function formatToken(asset) {
  const info     = asset.token_info ?? {};
  const symbol   = asset.content?.metadata?.symbol ?? info.symbol ?? "???";
  const decimals = info.decimals ?? 0;
  const rawBal   = info.balance ?? 0;
  const balance  = rawBal / 10 ** decimals;
  const usdPrice = info.price_info?.price_per_token ?? null;
  const usdValue = usdPrice !== null ? (balance * usdPrice).toFixed(2) : "n/a";
  return { symbol, balance: balance.toFixed(decimals > 4 ? 4 : decimals), usdValue };
}

// ── Run ────────────────────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║     DEMO: scenario_portfolio_snapshot.mjs (mock data)       ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

console.log(`Portfolio snapshot for ${MOCK_ADDRESS}\n`);

const solBal = MOCK_SOL_LAMPORTS / LAMPORTS;
const solUsd = (solBal * 168.42).toFixed(2); // mock SOL price
console.log(`${"SOL".padEnd(12)} ${solBal.toFixed(6).padStart(16)}   ~$${solUsd}`);
console.log("─".repeat(50));

const tokens = MOCK_ASSETS.map(formatToken).filter(t => parseFloat(t.balance) > 0);
tokens.sort((a, b) => (parseFloat(b.usdValue) || 0) - (parseFloat(a.usdValue) || 0));

for (const t of tokens) {
  const usd = t.usdValue !== "n/a" ? `  ~$${t.usdValue}` : "  (no price)";
  console.log(`${t.symbol.padEnd(12)} ${t.balance.padStart(16)}${usd}`);
}

console.log("─".repeat(50));

// total USD estimate
const totalUsd = (solBal * 168.42) +
  tokens.reduce((s, t) => s + (t.usdValue !== "n/a" ? parseFloat(t.usdValue) : 0), 0);
console.log(`Est. total:                    ~$${totalUsd.toFixed(2)}`);
console.log(`${tokens.length} SPL tokens found`);

console.log("\n── What's happening ────────────────────────────────────────────");
console.log("• getBalance (standard RPC) → native SOL");
console.log("• getAssetsByOwner (DAS, paid tier) → all fungible tokens with");
console.log("  symbol, decimals, and price_info already resolved by Helius.");
console.log("  No manual token account parsing or separate metadata lookups.");
console.log("• Tokens with zero balance are filtered; sorted by USD value desc.");
console.log("• DUST has no price_info — Helius returns null for illiquid tokens.");
console.log("\nTo run live: node scenario_portfolio_snapshot.mjs <address> $HELIUS_API_KEY");
