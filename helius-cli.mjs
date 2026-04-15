#!/usr/bin/env bun
// helius-cli.mjs — MEV & wallet tracker CLI
// Usage:
//   bun helius-cli.mjs profile  <address>
//   bun helius-cli.mjs sandwich <address>
//   bun helius-cli.mjs follow   <address>          ← follow the money
//   bun helius-cli.mjs watch    <addr1> <addr2>... ← live monitor
//   bun helius-cli.mjs cluster  <address>          ← find related wallets

import { fetchBalanceHistory } from './sol_balance_router.mjs';

const apiKey = process.env.HELIUS_API_KEY;
if (!apiKey) { console.error('Set HELIUS_API_KEY'); process.exit(1); }
const RPC = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const SOL = 1e9;

const KNOWN = {
  'CUQUKjGUv2bsNTAR9Bh9tF7njVE1Q3bkGWbkmsH2mqKx': 'SandwichProg',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpAMM',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'CPMM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'PumpFun',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca',
  'ComputeBudget111111111111111111111111111111':   'ComputeBudget',
  '11111111111111111111111111111111':              'System',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS':'AssocToken',
  'So1endDqwuwiTR43kMiegfNMEAiAVAkq7dza8jfJVe3R': 'Solend',
  'BPFLoaderUpgradeab1e11111111111111111111111':   'BPFUpgradeable',
  '33ySWW2846CRpnCDnY3jEqSi5CNKG8SxPKD6mvavJks':  'JitoBundleProg',
};

const lbl = addr => KNOWN[addr] ?? addr?.slice(0, 10) + '...';

// ── semaphore ─────────────────────────────────────────────────────────────────
function sem(n) {
  let a = 0; const q = [];
  return fn => new Promise((res, rej) => {
    const go = () => { a++; fn().then(v=>{a--;q.shift()?.();res(v)}).catch(e=>{a--;q.shift()?.();rej(e)}); };
    a < n ? go() : q.push(go);
  });
}
const s4 = sem(4);

async function rpc(method, params) {
  return s4(async () => {
    for (let i = 0; i < 4; i++) {
      const r = await fetch(RPC, { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0',id:1,method,params}) });
      const j = await r.json();
      if (j.error?.code === -32429) { await new Promise(r=>setTimeout(r,400*(i+1))); continue; }
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    }
  });
}

// ── PROFILE ───────────────────────────────────────────────────────────────────
async function cmdProfile(addr) {
  console.log(`\n🔍 PROFILE: ${addr}\n`);

  const [info, bal, sigs] = await Promise.all([
    rpc('getAccountInfo', [addr, {encoding:'base64'}]),
    rpc('getBalance', [addr]),
    rpc('getSignaturesForAddress', [addr, {limit:1000}]),
  ]);

  const isProgram  = info?.value?.executable ?? false;
  const owner      = info?.value?.owner ?? 'unknown';
  const balance    = (bal?.value ?? 0) / SOL;
  const failCount  = sigs?.filter(s => s.err)?.length ?? 0;
  const okCount    = (sigs?.length ?? 0) - failCount;

  // Top programs used
  const sample = sigs?.slice(0, 30) ?? [];
  const txs = (await Promise.all(sample.map(s =>
    rpc('getTransaction', [s.signature, {encoding:'json', maxSupportedTransactionVersion:0}]).catch(()=>null)
  ))).filter(Boolean);

  const progCount = {};
  for (const tx of txs) {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    for (const ix of tx.transaction?.message?.instructions ?? []) {
      const p = keys[ix.programIdIndex];
      if (p) progCount[lbl(p)] = (progCount[lbl(p)] ?? 0) + 1;
    }
  }
  const topProgs = Object.entries(progCount).sort((a,b)=>b[1]-a[1]).slice(0,6);

  console.log(`  Type       : ${isProgram ? '⚙️  PROGRAM (executable)' : '👛 Wallet'}`);
  console.log(`  Owner      : ${lbl(owner)}`);
  console.log(`  Balance    : ${balance.toFixed(6)} SOL`);
  console.log(`  Txs (1k)   : ${okCount} ok / ${failCount} failed`);
  console.log(`  Fail rate  : ${((failCount/(sigs?.length||1))*100).toFixed(1)}%`);
  if (failCount > 10) console.log(`  ⚠️  High fail rate = likely MEV bot (intentional fails)`);
  console.log(`\n  Top programs (last 30 txs):`);
  topProgs.forEach(([p,c]) => console.log(`    ${p.padEnd(20)} ×${c}`));

  // MEV verdict
  const isMEV = failCount > 5 || topProgs.some(([p]) => p.includes('Sandwich') || p.includes('Bundle'));
  const isDEX = topProgs.some(([p]) => ['Jupiter','Raydium','Orca','PumpAMM','CPMM'].includes(p));
  console.log(`\n  Verdict    : ${isProgram ? '⚙️ Protocol program' : isMEV ? '🚨 MEV bot' : isDEX ? '🔄 DeFi bot/trader' : '👤 User wallet'}`);
}

// ── SANDWICH ─────────────────────────────────────────────────────────────────
async function cmdSandwich(addr) {
  console.log(`\n🥪 SANDWICH SCAN: ${addr.slice(0,16)}...\n`);

  const sigs = await rpc('getSignaturesForAddress', [addr, {limit:500}]) ?? [];
  const bySlot = {};
  for (const s of sigs.filter(s=>!s.err)) (bySlot[s.slot]??=[]).push(s);

  const sandwichSlots = Object.entries(bySlot)
    .filter(([,v]) => v.length >= 2)
    .sort((a,b) => Number(b[0])-Number(a[0]))
    .slice(0, 5);

  console.log(`  Found ${sandwichSlots.length} sandwich slots in last 500 txs\n`);

  for (const [slot, botSigs] of sandwichSlots) {
    const txs = (await Promise.all(botSigs.map(s =>
      rpc('getTransaction',[s.signature,{encoding:'json',maxSupportedTransactionVersion:0}]).catch(()=>null)
    ))).filter(Boolean);

    let totalProfit = 0;
    console.log(`  Slot ${slot}  [${new Date(botSigs[0].blockTime*1000).toISOString().slice(0,19)}]  ${txs.length} txs`);

    for (let i = 0; i < txs.length; i++) {
      const tx   = txs[i];
      const keys = tx.transaction?.message?.accountKeys ?? [];
      const bi   = keys.indexOf(addr);
      const pre  = tx.meta?.preBalances?.[bi]  ?? 0;
      const post = tx.meta?.postBalances?.[bi] ?? 0;
      const d    = (post - pre) / SOL;
      totalProfit += d;
      const role = i===0 ? '🟢 FRONT' : i===txs.length-1 ? '🔴 BACK ' : '⚪ MID  ';
      const progs = [...new Set((tx.transaction?.message?.instructions??[])
        .map(ix=>lbl(keys[ix.programIdIndex])).filter(p=>!['ComputeBudget','System'].includes(p)))];
      console.log(`    ${role}  ${(d>=0?'+':'')}${d.toFixed(6)} SOL  [${progs.join(', ')}]`);
    }
    console.log(`    💰 Slot profit: ${totalProfit>=0?'+':''}${totalProfit.toFixed(6)} SOL\n`);
  }
}

// ── FOLLOW (follow the money) ─────────────────────────────────────────────────
async function cmdFollow(addr, depth = 0) {
  if (depth > 2) return;
  const pad = '  '.repeat(depth);
  console.log(`${pad}💸 FOLLOW: ${addr.slice(0,16)}...  (depth ${depth})`);

  const sigs = await rpc('getSignaturesForAddress', [addr, {limit:50}]) ?? [];
  const txs  = (await Promise.all(sigs.slice(0,10).map(s =>
    rpc('getTransaction',[s.signature,{encoding:'json',maxSupportedTransactionVersion:0}]).catch(()=>null)
  ))).filter(Boolean);

  const destinations = new Map();
  for (const tx of txs) {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const pre  = tx.meta?.preBalances  ?? [];
    const post = tx.meta?.postBalances ?? [];
    const srcIdx = keys.indexOf(addr);
    if (srcIdx === -1) continue;
    const srcDelta = (post[srcIdx]??0) - (pre[srcIdx]??0);
    if (srcDelta >= 0) continue;  // only outflows

    for (let i = 0; i < keys.length; i++) {
      if (i === srcIdx) continue;
      const d = (post[i]??0) - (pre[i]??0);
      if (d > 0.01 * SOL) {
        destinations.set(keys[i], (destinations.get(keys[i])??0) + d);
      }
    }
  }

  const sorted = [...destinations.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5);
  for (const [dest, lamports] of sorted) {
    console.log(`${pad}  → ${lbl(dest).padEnd(22)} +${(lamports/SOL).toFixed(4)} SOL  [${dest.slice(0,16)}...]`);
    if (depth < 1 && !KNOWN[dest]) await cmdFollow(dest, depth+1);
  }
}

// ── WATCH (live monitor) ──────────────────────────────────────────────────────
async function cmdWatch(addrs) {
  console.log(`\n👁  WATCHING ${addrs.length} address(es)... (Ctrl+C to stop)\n`);
  const lastSeen = {};
  for (const a of addrs) {
    const s = await rpc('getSignaturesForAddress',[a,{limit:1}]);
    lastSeen[a] = s?.[0]?.signature;
  }

  while (true) {
    await new Promise(r => setTimeout(r, 4000));
    for (const addr of addrs) {
      const sigs = await rpc('getSignaturesForAddress',[addr,{limit:5}]).catch(()=>[]) ?? [];
      const newSigs = [];
      for (const s of sigs) {
        if (s.signature === lastSeen[addr]) break;
        newSigs.push(s);
      }
      if (!newSigs.length) continue;
      lastSeen[addr] = sigs[0].signature;

      for (const s of newSigs) {
        const tx = await rpc('getTransaction',[s.signature,{encoding:'json',maxSupportedTransactionVersion:0}]).catch(()=>null);
        if (!tx) continue;
        const keys = tx.transaction?.message?.accountKeys ?? [];
        const progs = [...new Set((tx.transaction?.message?.instructions??[])
          .map(ix=>lbl(keys[ix.programIdIndex])).filter(p=>p!=='ComputeBudget'))];
        const bi  = keys.indexOf(addr);
        const d   = bi!==-1 ? ((tx.meta?.postBalances?.[bi]??0)-(tx.meta?.preBalances?.[bi]??0))/SOL : 0;
        const err = s.err ? '❌' : '✅';
        const ts  = new Date(s.blockTime*1000).toISOString().slice(11,19);
        console.log(`[${ts}] ${err} ${addr.slice(0,10)}...  ${d>=0?'+':''}${d.toFixed(4)} SOL  [${progs.slice(0,3).join(', ')}]  ${s.signature.slice(0,16)}...`);
      }
    }
  }
}

// ── CLUSTER (find related wallets) ───────────────────────────────────────────
async function cmdCluster(addr) {
  console.log(`\n🕸  CLUSTER: ${addr.slice(0,16)}...\n`);
  const sigs = await rpc('getSignaturesForAddress',[addr,{limit:200}]) ?? [];
  const txs  = (await Promise.all(sigs.slice(0,50).map(s =>
    rpc('getTransaction',[s.signature,{encoding:'json',maxSupportedTransactionVersion:0}]).catch(()=>null)
  ))).filter(Boolean);

  const coAppearance = {};
  for (const tx of txs) {
    const keys = tx.transaction?.message?.accountKeys ?? [];
    if (!keys.includes(addr)) continue;
    for (const k of keys) {
      if (k === addr || KNOWN[k]) continue;
      coAppearance[k] = (coAppearance[k]??0) + 1;
    }
  }

  const related = Object.entries(coAppearance)
    .filter(([,c]) => c >= 3)
    .sort((a,b)=>b[1]-a[1])
    .slice(0, 10);

  console.log(`  Addresses co-appearing 3+ times in same txs:\n`);
  for (const [a, count] of related) {
    const bal = await rpc('getBalance',[a]).catch(()=>null);
    const sol = ((bal?.value??0)/SOL).toFixed(4);
    console.log(`  ${a}  ×${String(count).padStart(3)}  ${sol} SOL`);
  }
}

// ── ROUTER ────────────────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

const HELP = `
helius-cli — MEV & wallet tracker

Commands:
  profile  <addr>              Full wallet profile + MEV verdict
  sandwich <addr>              Find sandwich attack patterns
  follow   <addr>              Follow the money (outflows)
  watch    <addr1> <addr2>...  Live monitor (polls every 4s)
  cluster  <addr>              Find co-appearing wallets (bot clusters)
`;

switch (cmd) {
  case 'profile':  await cmdProfile(args[0]); break;
  case 'sandwich': await cmdSandwich(args[0]); break;
  case 'follow':   await cmdFollow(args[0]); break;
  case 'watch':    await cmdWatch(args); break;
  case 'cluster':  await cmdCluster(args[0]); break;
  default:         console.log(HELP);
}
