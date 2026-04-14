// harness/router.mjs
// EvoHarness 入口：动态调用增强版路由测试
// 这个文件被 EvoHarness proposer 修改以进化策略参数

import { createEngine } from '../tools/gbrain/src/core/engine-factory.ts';

const HELIUS_API_KEY = Bun.env.HELIUS_API_KEY || "YOUR_HELIUS_API_KEY_HERE";
const RPC_URL = `https://beta.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// === EvoHarness Surfaces：以下参数会被自动进化 ===
const SURFACES = {
  // Surface 1: Periodic wallet 的分块策略
  periodicChunking: 12,          // 粗粒度时间分片数量（会被进化调整）

  // Surface 2: Mega wallet 的分层递归控制
  megaHierarchical: true,        // 是否启用分层递归
  megaRecursionDepth: 3,         // 递归深度（会被进化调整）

  // Surface 3: Band 逻辑选择
  bandLogic: "dynamic",          // "dynamic" | "fixed" | "adaptive"（会被进化选择）

  // Surface 4: Cache 策略
  cacheStrategy: "l0",           // "none" | "l0" | "l0-l1"（会被进化选择）

  // Surface 5: 最大并发 RPC 调用
  maxConcurrent: 8,              // 并发度（会被进化调整）
};

const gbrainEngine = await createEngine({ engine: 'pglite' });
await gbrainEngine.connect({ database_path: '../.gbrain/rpc-router.pglite', engine: 'pglite' });
await gbrainEngine.initSchema();

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

async function fetchFullChunk(address, startTime, endTime) {
  let token = null;
  let txs = [];
  do {
    const params = {
      transactionDetails: "full",
      sortOrder: "asc",
      limit: 100,
      filters: {
        status: "succeeded",
        tokenAccounts: "balanceChanged",
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

async function ingestToGBrain(result) {
  const slug = `experiments/rpc-router/${result.type}_${Date.now()}`;
  await gbrainEngine.putPage(slug, {
    type: 'experiment',
    title: `Router Test - ${result.type} wallet (${result.txCount} txns, surfaces_version: ${result.surfaces_version})`,
    compiled_truth: `Latency: ${result.latency}s | Tx Count: ${result.txCount} | Config: ${JSON.stringify(result.config)}`,
    timeline: `- ${new Date().toISOString()}: Tested ${result.type} wallet | Latency ${result.latency}s | ${result.txCount} changes | Surfaces: ${JSON.stringify(result.surfaces)}`,
    metadata: { result, surfaces: result.surfaces, surfaces_version: result.surfaces_version }
  });
  return slug;
}

async function getSOLBalanceHistory(address, walletType = "default") {
  const startMs = Date.now();
  
  // Phase 0: 快速探测 (signatures 模式)
  const [oldestRes, newestRes, densityRes] = await Promise.all([
    rpcCall("getTransactionsForAddress", [address, { transactionDetails: "signatures", sortOrder: "asc", limit: 1, filters: { status: "succeeded" } }]),
    rpcCall("getTransactionsForAddress", [address, { transactionDetails: "signatures", sortOrder: "desc", limit: 1, filters: { status: "succeeded" } }]),
    rpcCall("getTransactionsForAddress", [address, { transactionDetails: "signatures", limit: 100, filters: { status: "succeeded" } }]),
  ]);

  const minTime = oldestRes?.data?.[0]?.blockTime || 0;
  const maxTime = newestRes?.data?.[0]?.blockTime || Math.floor(Date.now() / 1000);
  const estimatedTx = densityRes?.data?.length || 0;

  console.log(`[${address.slice(0, 12)}...] ${walletType} | Est. tx: ~${estimatedTx} | Span: ${((maxTime - minTime) / 86400).toFixed(1)} days`);

  let allTxs = [];

  // === EvoHarness 进化路由逻辑 ===
  if (estimatedTx <= 50) {
    // Ultra-Sparse: 单调call
    const res = await rpcCall("getTransactionsForAddress", [address, {
      transactionDetails: "full",
      sortOrder: "asc",
      limit: 100,
      filters: { status: "succeeded", tokenAccounts: "balanceChanged" }
    }]);
    allTxs = res?.data || [];
  } 
  else if (walletType.includes("periodic") || (maxTime - minTime) / 86400 > 30) {
    // Periodic: 使用 periodicChunking 参数 (EvoHarness 会进化这个值)
    const NUM_CHUNKS = SURFACES.periodicChunking;
    const chunkSize = Math.ceil((maxTime - minTime) / NUM_CHUNKS);
    const promises = [];
    for (let i = 0; i < NUM_CHUNKS; i++) {
      const s = minTime + i * chunkSize;
      const e = Math.min(maxTime + 1, s + chunkSize);
      promises.push(fetchFullChunk(address, s, e));
    }
    const chunks = await Promise.all(promises);
    allTxs = chunks.flat();
  } 
  else if (walletType.includes("mega") || estimatedTx > 10000) {
    // Mega: 使用 megaHierarchical 和 megaRecursionDepth (EvoHarness 会进化)
    if (SURFACES.megaHierarchical) {
      // 分层递归: 先粗再细
      const BIG_CHUNKS = 4;
      const promises = [];
      for (let i = 0; i < BIG_CHUNKS; i++) {
        const s = minTime + (i * (maxTime - minTime)) / BIG_CHUNKS;
        const e = minTime + ((i + 1) * (maxTime - minTime)) / BIG_CHUNKS;
        promises.push(fetchFullChunk(address, s, e));
      }
      const bigChunks = await Promise.all(promises);
      allTxs = bigChunks.flat();
    } else {
      // 简单均匀分片
      const NUM_CHUNKS = 16;
      const chunkSize = Math.ceil((maxTime - minTime) / NUM_CHUNKS);
      const promises = [];
      for (let i = 0; i < NUM_CHUNKS; i++) {
        const s = minTime + i * chunkSize;
        const e = Math.min(maxTime + 1, s + chunkSize);
        promises.push(fetchFullChunk(address, s, e));
      }
      const chunks = await Promise.all(promises);
      allTxs = chunks.flat();
    }
  } 
  else {
    // Medium/Dense/Whale: 自适应分片 (EvoHarness 可进化 bandLogic)
    const NUM_CHUNKS = SURFACES.bandLogic === "dynamic" ? (estimatedTx > 5000 ? 16 : 8) : 8;
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

  // 去重 + 排序
  allTxs = [...new Map(allTxs.map(tx => [tx.signature, tx])).values()]
    .sort((a, b) => a.blockTime - b.blockTime || (a.transactionIndex || 0) - (b.transactionIndex || 0));

  // 构建 history
  const history = [];
  for (const tx of allTxs) {
    const idx = tx.transaction.message.accountKeys.indexOf(address);
    if (idx === -1) continue;
    const post = tx.meta.postBalances[idx];
    const pre = tx.meta.preBalances[idx];
    history.push({
      blockTime: tx.blockTime,
      signature: tx.signature,
      balanceLamports: post,
      deltaLamports: post - pre
    });
  }

  const latency = ((Date.now() - startMs) / 1000).toFixed(2);
  const result = {
    type: walletType,
    address: address.slice(0, 12) + "...",
    latency: parseFloat(latency),
    txCount: history.length,
    config: SURFACES,
    surfaces: SURFACES,  // 明确标记 surfaces 的值
    surfaces_version: "v2.0",  // 版本号让 EvoHarness 可追踪变化
  };

  const slug = await ingestToGBrain(result);
  console.log(`✅ ${walletType.toUpperCase()} | ${history.length} changes | Latency: ${latency}s | GBrain: ${slug}`);
  return result;
}

// 命令行接口：支持 EvoHarness 直接调用
if (process.argv.length >= 3) {
  const address = process.argv[2];
  const walletType = process.argv[3] || "default";
  
  getSOLBalanceHistory(address, walletType)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error("❌ Error:", err.message);
      process.exit(1);
    })
    .finally(() => gbrainEngine.disconnect());
} else {
  console.log("用法: bun router.mjs <address> [walletType]");
  process.exit(1);
}
