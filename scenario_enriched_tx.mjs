/**
 * Scenario 1: Enriched Transaction Breakdown
 *
 * Uses Helius's parsed transaction enrichment to get human-readable
 * labels (SWAP, TRANSFER, NFT_SALE, etc.) + native SOL transfers
 * without manually parsing account keys.
 *
 * Helius adds: type, source, nativeTransfers, tokenTransfers, accountData
 */

const LAMPORTS = 1_000_000_000;

async function getEnrichedTxs(address, apiKey, limit = 10) {
  // No type filter — let Helius return the most recent txs regardless of type.
  // Type filtering on old/busy wallets causes Helius to scan past the search
  // window and return a 404 with a pagination cursor instead of results.
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

function formatTx(tx) {
  const date = new Date(tx.timestamp * 1000).toISOString().slice(0, 19).replace("T", " ");
  const type = tx.type || "UNKNOWN";
  const source = tx.source || "?";

  const nativeIn  = (tx.nativeTransfers || []).filter(t => t.toUserAccount === tx.feePayer);
  const nativeOut = (tx.nativeTransfers || []).filter(t => t.fromUserAccount === tx.feePayer);

  const inSol  = nativeIn.reduce((s, t) => s + t.amount, 0) / LAMPORTS;
  const outSol = nativeOut.reduce((s, t) => s + t.amount, 0) / LAMPORTS;

  return `${date}  ${type.padEnd(20)} ${source.padEnd(16)} in:+${inSol.toFixed(4)}  out:-${outSol.toFixed(4)}  sig:${tx.signature.slice(0, 12)}…`;
}

const address = process.argv[2];
const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;

if (!address || !apiKey) {
  console.error("Usage: node scenario_enriched_tx.mjs <address> [api-key]");
  process.exit(1);
}

console.log(`Fetching enriched transactions for ${address}...\n`);
const txs = await getEnrichedTxs(address, apiKey);
console.log("DATE (UTC)           TYPE                 SOURCE           IN (SOL)   OUT (SOL)  SIG");
console.log("─".repeat(100));
for (const tx of txs) console.log(formatTx(tx));
console.log(`\nTotal: ${txs.length} txs`);
