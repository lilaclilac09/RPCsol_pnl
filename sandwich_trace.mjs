// sandwich_trace.mjs — find and display actual sandwich attack patterns
// Front-run → Victim → Back-run in same slot
const apiKey = process.env.HELIUS_API_KEY;
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const BOT_WALLETS = [
  'YubQzu18FDqJRyNfG8JqHmsdbxhnoQqcKUHBdUkN6tP',
  'YubVwWeg1vHFr17Q7HQQETcke7sFvMabqU8wbv8NXQW',
  'YubozzSnKomEnH3pkmYsdatUUwUTcm7s4mHJVmefEWj',
];
const SANDWICH_PROG = 'CUQUKjGUv2bsNTAR9Bh9tF7njVE1Q3bkGWbkmsH2mqKx';
const SOL = 1e9;

const KNOWN = {
  'CUQUKjGUv2bsNTAR9Bh9tF7njVE1Q3bkGWbkmsH2mqKx': 'SandwichProg',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpAMM',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'CPMM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'PumpFun',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca',
  'So11111111111111111111111111111111111111112':   'wSOL',
  'ComputeBudget111111111111111111111111111111':    'ComputeBudget',
  '11111111111111111111111111111111':               'System',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA':  'Token',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS': 'AssocToken',
  'So1endDqwuwiTR43kMiegfNMEAiAVAkq7dza8jfJVe3R': 'Solend',
};

async function rpc(method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

function label(addr) {
  if (!addr) return '?';
  if (BOT_WALLETS.includes(addr)) return `🤖 BOT(${addr.slice(0,8)})`;
  return KNOWN[addr] ?? addr.slice(0, 12) + '...';
}

function solDelta(pre, post) {
  const d = (post - pre) / SOL;
  return (d >= 0 ? '+' : '') + d.toFixed(4) + ' SOL';
}

async function getFullTx(sig) {
  return rpc('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
}

// Find slots where bot has 2+ txs (front-run + back-run)
async function findSandwichSlots(botAddr, limit = 200) {
  const sigs = await rpc('getSignaturesForAddress', [botAddr, { limit }]) ?? [];
  const succeeded = sigs.filter(s => !s.err);

  // Group by slot
  const bySlot = {};
  for (const s of succeeded) {
    (bySlot[s.slot] ??= []).push(s);
  }

  // Slots with 2+ bot txs = likely sandwich (front + back run)
  return Object.entries(bySlot)
    .filter(([, txs]) => txs.length >= 2)
    .sort((a, b) => Number(b[0]) - Number(a[0]))  // newest first
    .slice(0, 5);  // top 5 sandwich slots
}

async function traceSandwich(slot, botSigs, botAddr) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`SLOT ${slot}  — ${new Date(botSigs[0].blockTime * 1000).toISOString()}`);
  console.log(`${'═'.repeat(80)}`);

  // Fetch all bot txs in this slot
  const txs = (await Promise.all(botSigs.map(s => getFullTx(s.signature)))).filter(Boolean);

  // Sort by transaction index within block
  txs.sort((a, b) => {
    const ia = a.transaction?.message?.recentBlockhash ?? '';
    const ib = b.transaction?.message?.recentBlockhash ?? '';
    return (a.slot - b.slot) || 0;
  });

  let sandwichIdx = 0;
  for (const tx of txs) {
    sandwichIdx++;
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const ixs  = tx.transaction?.message?.instructions ?? [];
    const preBal  = tx.meta?.preBalances  ?? [];
    const postBal = tx.meta?.postBalances ?? [];

    const programs = [...new Set(
      ixs.map(ix => keys[ix.programIdIndex]).filter(Boolean)
    )].map(label).filter(l => l !== 'ComputeBudget' && l !== 'System');

    const botIdx = keys.indexOf(botAddr);
    const botDelta = botIdx !== -1
      ? solDelta(preBal[botIdx] ?? 0, postBal[botIdx] ?? 0)
      : 'N/A';

    const role = sandwichIdx === 1 ? '🟢 FRONT-RUN' : sandwichIdx === txs.length ? '🔴 BACK-RUN ' : '⚪ MID      ';

    console.log(`\n  ${role}  ${botSigs[sandwichIdx-1].signature.slice(0,20)}...`);
    console.log(`  Programs : ${programs.join(', ')}`);
    console.log(`  Bot SOL  : ${botDelta}`);
    console.log(`  Fee      : ${((tx.meta?.fee ?? 0) / SOL * 1000).toFixed(4)} mSOL`);

    // Show all account balance changes > 0.001 SOL (non-bot accounts = potential victims)
    const changes = [];
    for (let i = 0; i < keys.length; i++) {
      const delta = (postBal[i] ?? 0) - (preBal[i] ?? 0);
      if (Math.abs(delta) > 1_000_000 && keys[i] !== botAddr) {
        changes.push(`    ${label(keys[i]).padEnd(20)} ${solDelta(preBal[i], postBal[i])}`);
      }
    }
    if (changes.length) {
      console.log(`  Other Δ  :`);
      changes.forEach(c => console.log(c));
    }
  }

  // Profit summary
  const totalBotDelta = txs.reduce((sum, tx) => {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const bi = keys.indexOf(botAddr);
    if (bi === -1) return sum;
    return sum + (tx.meta?.postBalances?.[bi] ?? 0) - (tx.meta?.preBalances?.[bi] ?? 0);
  }, 0);

  console.log(`\n  💰 Net profit this sandwich: ${solDelta(0, totalBotDelta)}`);
}

// Main
async function main() {
  console.log('🔍 Scanning for sandwich attack patterns...\n');

  for (const botAddr of BOT_WALLETS) {
    const shortAddr = botAddr.slice(0, 12);
    console.log(`\nScanning bot: ${shortAddr}...`);

    const sandwichSlots = await findSandwichSlots(botAddr, 300);

    if (!sandwichSlots.length) {
      console.log('  No sandwich slots found in last 300 txs');
      continue;
    }

    console.log(`  Found ${sandwichSlots.length} sandwich slots`);

    // Trace the 3 most recent
    for (const [slot, botSigs] of sandwichSlots.slice(0, 3)) {
      await traceSandwich(slot, botSigs, botAddr);
    }
    break; // Show one bot's sandwiches in detail, can remove to show all
  }
}

main().catch(console.error);
