/**
 * explore_batch.mjs — Quick SOL balance + token snapshot for a list of wallets
 *
 * Usage: node explore_batch.mjs [api_key]
 */

import { makeHelius, timed, parallel, printTable } from "./oliver.mjs";

const WALLETS = [
  "BkMx5bRzQeP6tUZgzEs3xeDWJfQiLYvNDqSgmGZKYJDq",
  "CwWZzvRgmxj9WLLhdoWUVrHZ1J8db3w2iptKuAitHqoC",
  "4uRnem4BfVpZBv7kShVxUYtcipscgZMSHi3B9CSL6gAA",
  "AzfhMPcx3qjbvCK3UUy868qmc5L451W341cpFqdL3EBe",
  "84DrGKhycCUGfLzw8hXsUYX9SnWdh2wW3ozsTPrC5xyg",
  "7aewvu8fMf1DK4fKoMXKfs3h3wpAQ7r7D8T1C71LmMF",
  "G2d63CEgKBdgtpYT2BuheYQ9HFuFCenuHLNyKVpqAuSD",
  "F7ThiQUBYiEcyaxpmMuUeACdoiSLKg4SZZ8JSfpFNwAf",
];

const API_KEY = process.argv[2] ?? process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.error("Usage: node explore_batch.mjs [api_key]  OR  HELIUS_API_KEY=xxx node explore_batch.mjs");
  process.exit(1);
}

const helius = makeHelius(API_KEY);

// For each wallet: fire getBalance + getAssetsByOwner + getSignaturesForAddress in parallel
async function exploreWallet(address) {
  const short = address.slice(0, 8) + "…" + address.slice(-4);

  const tasks = [
    timed("balance", () => helius.rpc("getBalance", [address, { commitment: "confirmed" }]), 1),
    timed("assets",  () => helius.das("getAssetsByOwner", {
      ownerAddress: address, page: 1, limit: 20,
      displayOptions: { showFungible: true, showNativeBalance: true },
    }), 1),
    timed("history", () => helius.rpc("getSignaturesForAddress", [address, { limit: 5 }]), 1),
    timed("tokens",  () => helius.rpc("getTokenAccountsByOwner", [
      address,
      { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]), 1),
  ];

  const { results, wallMs } = await parallel(tasks);

  const bal    = results.find(r => r.label === "balance");
  const assets = results.find(r => r.label === "assets");
  const hist   = results.find(r => r.label === "history");
  const toks   = results.find(r => r.label === "tokens");

  const solLamports = bal?.status === "ok" ? bal.result.value : null;
  const solBalance  = solLamports != null ? (solLamports / 1e9).toFixed(4) : "err";
  const solPriceUSD = assets?.status === "ok" ? assets.result?.nativeBalance?.price_per_sol : null;
  const solValueUSD = solPriceUSD != null && solLamports != null
    ? (solLamports / 1e9 * solPriceUSD).toFixed(2)
    : "?";
  const txCount     = hist?.status === "ok" ? hist.result?.length : "err";
  const tokenCount  = toks?.status === "ok" ? toks.result?.value?.length : "err";
  const nftCount    = assets?.status === "ok"
    ? (assets.result?.items ?? []).filter(i => !i.interface?.includes("FungibleToken")).length
    : "?";

  // Top fungible tokens by amount
  const fungibles = assets?.status === "ok"
    ? (assets.result?.items ?? [])
        .filter(i => i.interface?.includes("FungibleToken") || i.token_info?.balance)
        .slice(0, 5)
        .map(i => `${i.token_info?.symbol ?? i.id.slice(0,6)} ${i.token_info?.balance ?? ""}`)
    : [];

  // Recent tx signatures
  const recentSigs = hist?.status === "ok"
    ? (hist.result ?? []).slice(0, 3).map(s => s.signature.slice(0,8) + "…")
    : [];

  return {
    address, short, solBalance, solValueUSD, txCount, tokenCount, nftCount,
    fungibles, recentSigs, wallMs,
    errors: results.filter(r => r.status === "err").map(r => `${r.label}: ${r.error}`),
  };
}

async function main() {
  const t0 = performance.now();

  console.log(`\n${"═".repeat(72)}`);
  console.log(` Batch Explorer — ${WALLETS.length} wallets (Oliver parallel pattern)`);
  console.log(`${"═".repeat(72)}\n`);

  // Explore all wallets in parallel
  const summaries = await Promise.all(WALLETS.map(exploreWallet));

  const totalMs = performance.now() - t0;

  // Print summary table
  console.log(` ${"ADDRESS".padEnd(14)}  ${"SOL".padStart(10)}  ${"USD".padStart(10)}  ${"TOKENS".padStart(7)}  ${"TXs".padStart(5)}  ${"ms".padStart(5)}`);
  console.log(` ${"─".repeat(66)}`);

  for (const s of summaries) {
    const sol   = s.solBalance.padStart(10);
    const usd   = `$${s.solValueUSD}`.padStart(10);
    const toks  = String(s.tokenCount).padStart(7);
    const txs   = String(s.txCount).padStart(5);
    const ms    = `${s.wallMs.toFixed(0)}ms`.padStart(5);
    console.log(` ${s.short.padEnd(14)}  ${sol}  ${usd}  ${toks}  ${txs}  ${ms}`);
  }

  console.log(`\n Wall time for all ${WALLETS.length} wallets (parallel): ${totalMs.toFixed(0)}ms`);
  console.log(`${"═".repeat(72)}\n`);

  // Print per-wallet detail
  for (const s of summaries) {
    console.log(`\n──── ${s.address} ────`);
    console.log(`  SOL:       ${s.solBalance} SOL  ≈ $${s.solValueUSD}`);
    console.log(`  SPL tokens: ${s.tokenCount}  |  NFTs (approx): ${s.nftCount}`);
    if (s.fungibles.length)  console.log(`  Top fungibles: ${s.fungibles.join("  ")}`);
    if (s.recentSigs.length) console.log(`  Recent sigs:   ${s.recentSigs.join("  ")}`);
    if (s.errors.length)     console.log(`  ⚠ Errors: ${s.errors.join("; ")}`);
  }

  console.log();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
