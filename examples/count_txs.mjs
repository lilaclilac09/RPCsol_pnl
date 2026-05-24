// count_txs.mjs — exact tx count for any list of wallets
const apiKey = process.env.HELIUS_API_KEY;
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const wallets = [
  // Original suspects
  ['YubQzu18', 'YubQzu18FDqJRyNfG8JqHmsdbxhnoQqcKUHBdUkN6tP'],
  ['YubVwWeg1', 'YubVwWeg1vHFr17Q7HQQETcke7sFvMabqU8wbv8NXQW'],
  ['AEB9dXBox', 'AEB9dXBoxkrapNd59Kg29JefMMf3M1WLcNA12XjKSf4R'],
  ['E2MPTDnFP', 'E2MPTDnFPNiCRmbJGKYSYew48NWRGVNfHjoiibFP5VL2'],
  ['YubozzSnK', 'YubozzSnKomEnH3pkmYsdatUUwUTcm7s4mHJVmefEWj'],
  // New addresses
  ['6EF8rrecth', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
  ['EumFF6mx6m', 'EumFF6mx6mTPW9VSJsPmrmqgLF9amvzKwXfQfyrkwMTH'],
  ['8jXneHCUpb', '8jXneHCUpbGQpSmSz9TgJhhXCW2vJyzbtXZLT9xrLyon'],
  ['9FcKTaqDQH', '9FcKTaqDQHfhuRvqjtmUpMiMJtVdbQWa6M8WuDThqqbx'],
  ['GxkuFR1Wtk', 'GxkuFR1WtkniWPT5xpf4FVqgD929WgFHyy8F82oMuoce'],
  ['4bwoPeP9UT', '4bwoPeP9UTEF7evUR6jkLZP4RbEJr2mULfxiMTa11mQG'],
  ['69f3WXVx1J', '69f3WXVx1JXRTZ5aELcjvi46GWGvd6iHmkoyAPiPQyoU'],
  ['Ree1er4BCi', 'Ree1er4BCisdLLLYmqSb39KZtZ2LL4moSb1mtmPx5pG'],
  ['pAMMBay6oc', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'],
  ['cpamdpZCGK', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'],
];

const MAX_PAGES = 20;  // cap at 20k txs per wallet to avoid program accounts hanging

async function countSigs(address) {
  let total = 0, before, pages = 0;
  do {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: 1000, ...(before && { before }) }],
      }),
    });
    const page = (await res.json()).result ?? [];
    if (!page.length) break;
    total += page.length;
    before = page.at(-1).signature;
    pages++;
    if (page.length < 1000) break;
    if (pages >= MAX_PAGES) { return { total, pages, capped: true }; }
  } while (true);
  return { total, pages, capped: false };
}

console.log('Counting transactions for all wallets...\n');
for (const [label, addr] of wallets) {
  const t0 = Date.now();
  const { total, pages, capped } = await countSigs(addr);
  const flag = capped ? '  ⚠️  20k+ (program account?)' : '';
  console.log(`${label.padEnd(14)} ${String(total).padStart(6)} txs  (${pages} pages)  ${Date.now()-t0}ms${flag}`);
}
