// test_all_wallets_enhanced.mjs
// Uses the proven sol_balance_router.mjs + GBrain auto-ingest
// Run: bun test_all_wallets_enhanced.mjs <addr1> <addr2> ...
// Or:  bun test_all_wallets_enhanced.mjs   (uses default research wallets)

import { fetchBalanceHistory } from './sol_balance_router.mjs';
import { createEngine } from './tools/gbrain/src/core/engine-factory.ts';
// ── Oliver-style: paginate ALL signatures for exact total tx count ─────────────
async function countAllSigs(address, apiKey) {
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

  async function fetchSigs(before) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: 1000, commitment: 'finalized', ...(before && { before }) }],
      }),
    });
    return (await res.json()).result ?? [];
  }

  let total = 0, before, pages = 0;
  do {
    const page = await fetchSigs(before);
    if (!page.length) break;
    total += page.length;
    before = page.at(-1).signature;
    pages++;
    if (page.length < 1000) break;
  } while (true);

  return { total, pages };
}

const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? "YOUR_HELIUS_API_KEY_HERE";

// Default research wallets (known types)
const DEFAULT_WALLETS = {
  sparse: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs",
  medium: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs",
  dense:  "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n",
};

// CLI: bun test_all_wallets_enhanced.mjs <addr1> <addr2> ...
const cliAddresses = process.argv.slice(2).filter(a => a.length >= 32 && !a.startsWith('--'));
const WALLETS = cliAddresses.length > 0
  ? Object.fromEntries(cliAddresses.map((addr, i) => [`wallet_${i + 1}`, addr]))
  : DEFAULT_WALLETS;

// GBrain setup
const gbrainEngine = await createEngine({ engine: 'pglite' });
const home = process.env.HOME || process.env.USERPROFILE;
await gbrainEngine.connect({ database_path: `${home}/.gbrain/brain.pglite`, engine: 'pglite' });
await gbrainEngine.initSchema();

async function ingestToGBrain(label, result, latencyMs) {
  const slug = `experiments/rpc-router/${label}_${Date.now()}`;
  const pts = result.points?.filter(p => p.kind !== 'flat') ?? [];
  await gbrainEngine.putPage(slug, {
    type: 'project',
    title: `Router Test — ${label} (${pts.length} balance changes, ${latencyMs}ms)`,
    compiled_truth: [
      `Address: ${result.address ?? label}`,
      `Balance changes: ${pts.length}`,
      `Opening: ${(result.openingLamports / 1e9).toFixed(6)} SOL`,
      `Closing: ${(result.closingLamports / 1e9).toFixed(6)} SOL`,
      `Net: ${((result.closingLamports - result.openingLamports) / 1e9).toFixed(6)} SOL`,
      `Latency: ${latencyMs}ms`,
    ].join(' | '),
    timeline: `- ${new Date().toISOString()}: Tested ${label} | ${pts.length} changes | ${latencyMs}ms`,
  });
  console.log(`  → GBrain: saved as ${slug}`);
}

async function main() {
  if (!HELIUS_API_KEY || HELIUS_API_KEY === "YOUR_HELIUS_API_KEY_HERE") {
    console.error("❌ Set HELIUS_API_KEY env var first.");
    process.exit(1);
  }

  console.log(`🚀 Testing ${Object.keys(WALLETS).length} wallet(s)...\n`);

  for (const [label, addr] of Object.entries(WALLETS)) {
    if (!addr || addr.length < 32) {
      console.log(`⚠️  Skipping ${label} — invalid address`);
      continue;
    }

    console.log(`[${label}] ${addr.slice(0, 16)}...`);
    const t0 = Date.now();
    try {
      const [result, sigCount] = await Promise.all([
        fetchBalanceHistory(addr, HELIUS_API_KEY),
        countAllSigs(addr, HELIUS_API_KEY),
      ]);
      const ms = Date.now() - t0;
      const pts = result.points?.filter(p => p.kind !== 'flat') ?? [];
      const s = result.stats ?? {};
      const walletType = s.walletType ?? '?';
      const tier = s.apiTier ?? result.routing?.tier ?? '?';
      console.log(`  ✅ ${sigCount.total} total txs (${sigCount.pages} pages) | ${pts.length} SOL balance changes | type: ${walletType} | tier: ${tier} | ${ms}ms`);
      if (pts.length > 0) {
        const last = pts[pts.length - 1];
        console.log(`  Closing balance: ${(last.lamports / 1e9).toFixed(6)} SOL`);
      }
      await ingestToGBrain(label, result, ms);
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 600));
  }

  console.log("\n🎉 Done — results saved to GBrain.");
  await gbrainEngine.disconnect();
}

main().catch(err => { console.error("❌", err); process.exit(1); });
