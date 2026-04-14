// test_all_wallets_enhanced.mjs
// EvoHarness + GBrain 全闭环增强版
// 运行方式：bun test_all_wallets_enhanced.mjs
// 特性：Helius full + balanceChanged + Gatekeeper + GBrain auto-ingest

import { createEngine } from './tools/gbrain/src/core/engine-factory.ts';

const HELIUS_API_KEY = "YOUR_HELIUS_API_KEY_HERE";   // ← 必须替换成你的真实 Key
const RPC_URL = `https://beta.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;  // Gatekeeper Beta，低延迟

const WALLETS = {
  sparse: "54uJ1fihfL...TmTs",     // ← 替换完整地址
  medium: "54u5q7Wt...wsTs",
  dense: "59tGC1H1...1P8n",
  whale: "8NCLTHT1...mj6",
  // periodic: "你的 periodic 地址",
  // burst: "你的 burst 地址",
  // large: "你的 large 地址",
  // mega: "你的 mega 地址",
};

const gbrainEngine = await createEngine({ engine: 'pglite' });
await gbrainEngine.connect({ database_path: '.gbrain/rpc-router.pglite', engine: 'pglite' });
await gbrainEngine.initSchema();   // 确保 schema 就绪

// GBrain 自动 ingest 函数
async function ingestToGBrain(result) {
  const slug = `experiments/rpc-router/${result.type}_${Date.now()}`;
  await gbrainEngine.putPage(slug, {
    type: 'experiment',
    title: `Router Test - ${result.type} wallet (${result.txCount} txns)`,
    compiled_truth: `Latency: ${result.latency}s | Tx Count: ${result.txCount} | Wallet Type: ${result.type} | Config: ${JSON.stringify(result.config)}`,
    timeline: `- ${new Date().toISOString()}: Tested ${result.type} wallet | Latency ${result.latency}s | ${result.txCount} balance changes`,
    metadata: result
  });
  console.log(`✅ GBrain 已记录: ${result.type} wallet (latency ${result.latency}s)`);
}

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC Error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// 核心抓取函数（支持 full + balanceChanged + pagination + blockTime range）
async function fetchFullChunk(address, startTime, endTime, paginationToken = null) {
  let token = paginationToken;
  let txs = [];
  do {
    const params = {
      transactionDetails: "full",                    // 一步拿完整数据（含 pre/postBalances）
      sortOrder: "asc",
      limit: 100,                                    // full 模式最大 100
      filters: {
        status: "succeeded",
        tokenAccounts: "balanceChanged",             // 推荐：只返回影响余额的 tx，过滤垃圾
        blockTime: { gte: startTime, lt: endTime }
      },
      ...(token && { paginationToken: token })
    };

    const result = await rpcCall("getTransactionsForAddress", [address, params]);
    txs.push(...(result?.data || []));
    token = result?.paginationToken || null;
  } while (token);
  return txs;
}

async function getSOLBalanceHistory(address, type = "default") {
  const startMs = Date.now();
  const config = { 
    mode: type, 
    fullMode: true, 
    gatekeeper: true,
    tokenFilter: "balanceChanged",
    // EvoHarness 会重点进化下面这些 surfaces
    periodicChunking: type.includes("periodic") ? 12 : 8,
    megaHierarchical: type.includes("mega") ? true : false,
    bandLogic: "dynamic"
  };

  // Phase 0: 快速探测（用 signatures，速度优先）
  const [oldestRes, newestRes, densityRes] = await Promise.all([
    rpcCall("getTransactionsForAddress", [address, { transactionDetails: "signatures", sortOrder: "asc", limit: 1, filters: { status: "succeeded" } }]),
    rpcCall("getTransactionsForAddress", [address, { transactionDetails: "signatures", sortOrder: "desc", limit: 1, filters: { status: "succeeded" } }]),
    rpcCall("getTransactionsForAddress", [address, { transactionDetails: "signatures", limit: 100, filters: { status: "succeeded" } }]),
  ]);

  const minTime = oldestRes?.data?.[0]?.blockTime || 0;
  const maxTime = newestRes?.data?.[0]?.blockTime || Math.floor(Date.now() / 1000);
  const estimatedTx = densityRes?.data?.length || 0;

  console.log(`[${address.slice(0, 12)}...] ${type} | Est. tx: ~${estimatedTx} | Span: ${((maxTime - minTime) / 86400).toFixed(1)} days`);

  let allTxs = [];

  if (estimatedTx <= 50 || type === "sparse") {
    // Ultra-Sparse / Sparse：直接一个 full 调用
    const res = await rpcCall("getTransactionsForAddress", [address, {
      transactionDetails: "full",
      sortOrder: "asc",
      limit: 100,
      filters: { status: "succeeded", tokenAccounts: "balanceChanged" }
    }]);
    allTxs = res?.data || [];
  } else if (type.includes("periodic") || (maxTime - minTime) / 86400 > 30) {
    // Periodic / Burst：粗粒度 blockTime 预切（空 chunk 几乎 0 成本）
    const NUM_BIG_CHUNKS = config.periodicChunking;
    const chunkSize = Math.ceil((maxTime - minTime) / NUM_BIG_CHUNKS);
    const promises = [];
    for (let i = 0; i < NUM_BIG_CHUNKS; i++) {
      const s = minTime + i * chunkSize;
      const e = Math.min(maxTime + 1, s + chunkSize);
      promises.push(fetchFullChunk(address, s, e));
    }
    const chunks = await Promise.all(promises);
    allTxs = chunks.flat();
  } else {
    // Medium / Dense / Whale / Large：你的 balanced 风格 + full
    const NUM_CHUNKS = estimatedTx > 10000 ? 16 : 8;
    const chunkSize = Math.max(3600, Math.ceil((maxTime - minTime) / NUM_CHUNKS));
    const promises = [];
    for (let i = 0; i < NUM_CHUNKS; i++) {
      const s = minTime + i * chunkSize;
      const e = Math.min(maxTime + 1, s + chunkSize);
      promises.push(fetchFullChunk(address, s, e));
    }
    const chunks = await Promise.all(promises);
    allTxs = chunks.flat();
  }

  // 去重 + 按时间排序
  allTxs = [...new Map(allTxs.map(tx => [tx.signature, tx])).values()]
    .sort((a, b) => a.blockTime - b.blockTime || (a.transactionIndex || 0) - (b.transactionIndex || 0));

  // 构建 balance history
  const history = [];
  let currentBalance = 0;
  for (const tx of allTxs) {
    const idx = tx.transaction.message.accountKeys.indexOf(address);
    if (idx === -1) continue;
    const pre = tx.meta.preBalances[idx];
    const post = tx.meta.postBalances[idx];
    if (history.length === 0) currentBalance = pre;
    currentBalance = post;
    history.push({
      blockTime: tx.blockTime,
      signature: tx.signature,
      balanceLamports: post,
      deltaLamports: post - pre
    });
  }

  const latency = ((Date.now() - startMs) / 1000).toFixed(2);
  const result = {
    type,
    address: address.slice(0, 12) + "...",
    latency: parseFloat(latency),
    txCount: history.length,
    config,
    sampleHistory: history.slice(0, 3)   // 只存前3条示例
  };

  await ingestToGBrain(result);
  console.log(`✅ ${type.toUpperCase()} | ${history.length} changes | Latency: ${latency}s`);
  return result;
}

async function main() {
  console.log("🚀 EvoHarness + GBrain 增强版测试启动...\n");
  for (const [type, addr] of Object.entries(WALLETS)) {
    if (!addr || addr.includes("...")) {
      console.log(`⚠️  请先替换 ${type} 的完整地址`);
      continue;
    }
    await getSOLBalanceHistory(addr, type);
    await new Promise(r => setTimeout(r, 800)); // 避免 rate limit
  }
  console.log("\n🎉 全部测试完成！所有结果已自动写入 GBrain（可被 EvoHarness 查询进化）");
  await gbrainEngine.disconnect();
}

main().catch(err => console.error("❌ Error:", err));
