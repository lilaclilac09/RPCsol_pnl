// track_wallets.mjs — exact tx count + activity breakdown for suspect wallets
const apiKey = process.env.HELIUS_API_KEY;
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

// Known program IDs
const PROGRAMS = {
  '11111111111111111111111111111111': 'System',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'PumpFun',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpAMM',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'CPMM',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca',
  'ComputeBudget111111111111111111111111111111': 'ComputeBudget',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS': 'AssocToken',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'Metaplex',
  'So11111111111111111111111111111111111111112': 'wSOL',
};

const wallets = [
  ['YubQzu18',   'YubQzu18FDqJRyNfG8JqHmsdbxhnoQqcKUHBdUkN6tP'],
  ['YubVwWeg1',  'YubVwWeg1vHFr17Q7HQQETcke7sFvMabqU8wbv8NXQW'],
  ['AEB9dXBox',  'AEB9dXBoxkrapNd59Kg29JefMMf3M1WLcNA12XjKSf4R'],
  ['E2MPTDnFP',  'E2MPTDnFPNiCRmbJGKYSYew48NWRGVNfHjoiibFP5VL2'],
  ['YubozzSnK',  'YubozzSnKomEnH3pkmYsdatUUwUTcm7s4mHJVmefEWj'],
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

// Semaphore — max 4 concurrent RPC calls
function semaphore(limit) {
  let active = 0; const queue = [];
  return fn => new Promise((resolve, reject) => {
    const run = () => { active++; fn().then(v => { active--; queue.shift()?.(); resolve(v); }).catch(e => { active--; queue.shift()?.(); reject(e); }); };
    active < limit ? run() : queue.push(run);
  });
}
const sem = semaphore(4);

async function rpc(method, params) {
  return sem(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await res.json();
      if (j.error?.code === -32429) {
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    }
    throw new Error('rate limit exhausted');
  });
}

// Exact count — caps at 50k to avoid hanging on program accounts (millions of txs)
async function exactCount(address) {
  let total = 0, before, pages = 0;
  do {
    const page = await rpc('getSignaturesForAddress', [address, { limit: 1000, ...(before && { before }) }]) ?? [];
    if (!page.length) break;
    total += page.length;
    before = page.at(-1).signature;
    pages++;
    if (page.length < 1000) break;
    if (pages >= 50) return { total, capped: true };  // 50k+ = program account
  } while (true);
  return { total, capped: false };
}

// Fetch last N transactions and classify by programs used
async function classifyActivity(address, n = 15) {
  const sigs = await rpc('getSignaturesForAddress', [address, { limit: n }]) ?? [];
  const succeeded = sigs.filter(s => !s.err).slice(0, n);

  const txs = await Promise.all(
    succeeded.map(s => rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }])
      .catch(() => null))
  );

  const programCounts = {};
  let solTransfers = 0, tokenSwaps = 0, failed = sigs.filter(s => s.err).length;

  for (const tx of txs) {
    if (!tx) continue;
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const instructions = tx.transaction?.message?.instructions ?? [];

    for (const ix of instructions) {
      const prog = keys[ix.programIdIndex] ?? ix.programId;
      if (!prog) continue;
      const label = PROGRAMS[prog] ?? prog.slice(0, 8) + '...';
      programCounts[label] = (programCounts[label] ?? 0) + 1;
    }

    // SOL balance change
    const addrIdx = keys.indexOf(address);
    if (addrIdx !== -1) {
      const pre  = tx.meta?.preBalances?.[addrIdx]  ?? 0;
      const post = tx.meta?.postBalances?.[addrIdx] ?? 0;
      if (Math.abs(post - pre) > 5000) solTransfers++;
    }

    // Token swap heuristic: has Jupiter or Raydium or Orca
    const progLabels = Object.keys(programCounts);
    if (progLabels.some(l => ['Jupiter','Raydium','Orca','PumpAMM','CPMM','PumpFun'].includes(l))) {
      tokenSwaps++;
    }
  }

  const topPrograms = Object.entries(programCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}(${v})`)
    .join(', ');

  return { topPrograms, solTransfers, tokenSwaps: Math.min(tokenSwaps, succeeded.length), failed };
}

console.log('═'.repeat(100));
console.log(`${'Wallet'.padEnd(14)} ${'Total Txs'.padStart(10)}  ${'SOL Δ'.padStart(6)}  ${'Swaps'.padStart(5)}  ${'Fail'.padStart(4)}  Top Programs`);
console.log('─'.repeat(100));

// Process each wallet: count + classify, print as each finishes
await Promise.all(wallets.map(async ([label, addr]) => {
  const [{ total, capped }, activity] = await Promise.all([
    exactCount(addr),
    classifyActivity(addr, 15),
  ]);
  const { topPrograms, solTransfers, tokenSwaps, failed } = activity;
  const totalStr = capped ? `${total}+` : String(total);
  const flag = capped ? ' ⚠️ PROGRAM' : '';
  console.log(`${label.padEnd(14)} ${totalStr.padStart(10)}  ${String(solTransfers).padStart(6)}  ${String(tokenSwaps).padStart(5)}  ${String(failed).padStart(4)}  ${topPrograms}${flag}`);
}));

console.log('═'.repeat(100));
