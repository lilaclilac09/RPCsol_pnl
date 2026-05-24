/**
 * Scenario 3: Portfolio Snapshot — SOL + SPL Token balances in one call
 *
 * Uses DAS getAssetsByOwner to list all fungible tokens a wallet holds,
 * then merges with native SOL balance from standard RPC.
 *
 * No manual token account parsing needed — Helius resolves symbol/decimals.
 *
 * Usage: node scenario_portfolio_snapshot.mjs <address> [api-key]
 */

const LAMPORTS = 1_000_000_000;

async function getSolBalance(address, apiKey) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
  });
  const j = await r.json();
  return j.result?.value ?? 0;
}

async function getFungibleAssets(address, apiKey) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  let page = 1;
  const assets = [];

  while (true) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: page,
        method: "getAssetsByOwner",
        params: {
          ownerAddress: address,
          page,
          limit: 1000,
          displayOptions: { showFungible: true, showNativeBalance: false },
        },
      }),
    });
    const j = await r.json();
    const items = j.result?.items ?? [];
    assets.push(...items.filter(a => a.interface === "FungibleToken" || a.interface === "FungibleAsset"));
    if (items.length < 1000) break;
    page++;
  }

  return assets;
}

function formatToken(asset) {
  const info    = asset.token_info ?? {};
  const symbol  = asset.content?.metadata?.symbol ?? info.symbol ?? "???";
  const decimals = info.decimals ?? 0;
  const rawBal  = info.balance ?? 0;
  const balance  = rawBal / 10 ** decimals;
  const usdPrice = info.price_info?.price_per_token ?? null;
  const usdValue = usdPrice !== null ? (balance * usdPrice).toFixed(2) : "n/a";
  return { symbol, balance: balance.toFixed(decimals > 4 ? 4 : decimals), usdValue };
}

const address = process.argv[2];
const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;

if (!address || !apiKey) {
  console.error("Usage: node scenario_portfolio_snapshot.mjs <address> [api-key]");
  process.exit(1);
}

console.log(`Portfolio snapshot for ${address}\n`);

const [solLamports, fungibles] = await Promise.all([
  getSolBalance(address, apiKey),
  getFungibleAssets(address, apiKey),
]);

const solBal = solLamports / LAMPORTS;
console.log(`${"SOL".padEnd(12)} ${solBal.toFixed(6).padStart(16)}   (native)`);
console.log("─".repeat(50));

const tokens = fungibles.map(formatToken).filter(t => parseFloat(t.balance) > 0);
tokens.sort((a, b) => parseFloat(b.usdValue) - parseFloat(a.usdValue));

for (const t of tokens) {
  const usd = t.usdValue !== "n/a" ? `  ~$${t.usdValue}` : "";
  console.log(`${t.symbol.padEnd(12)} ${t.balance.padStart(16)}${usd}`);
}

console.log("─".repeat(50));
console.log(`${tokens.length} SPL tokens found`);
