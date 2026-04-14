// test_gbrain_connection.mjs
// 验证 GBrain 连接和基础操作

import { createEngine } from './tools/gbrain/src/core/engine-factory.ts';

async function testGBrainConnection() {
  console.log("🧪 启动 GBrain 连接测试...\n");
  
  try {
    const gbrainEngine = await createEngine({ engine: 'pglite' });
    console.log("✅ GBrain engine 创建成功");
    
    await gbrainEngine.connect({ database_path: '.gbrain/test.pglite', engine: 'pglite' });
    console.log("✅ 数据库连接成功");
    
    await gbrainEngine.initSchema();
    console.log("✅ Schema 初始化成功");
    
    // 测试写入一条样本记录
    const testResult = {
      type: "test",
      address: "test-addr...",
      latency: 0.5,
      txCount: 42,
      config: { testMode: true }
    };
    
    const testSlug = `experiments/rpc-router/test_${Date.now()}`;
    await gbrainEngine.putPage(testSlug, {
      type: 'experiment',
      title: `GBrain Connection Test - ${new Date().toISOString()}`,
      compiled_truth: `Test latency: ${testResult.latency}s | Tx count: ${testResult.txCount}`,
      timeline: `- ${new Date().toISOString()}: GBrain connection test successful`,
      metadata: testResult
    });
    console.log("✅ 测试数据写入成功:", testSlug);
    
    // 测试读取
    const page = await gbrainEngine.getPage(testSlug);
    console.log("✅ 测试数据读取成功");
    console.log(`   Title: ${page.title}`);
    console.log(`   Truth: ${page.compiled_truth}`);
    
    await gbrainEngine.disconnect();
    console.log("✅ 数据库连接已关闭");
    
    console.log("\n🎉 GBrain 全功能正常！");
    console.log("\n📝 下一步：在 test_all_wallets_enhanced.mjs 中配置:");
    console.log("   1. HELIUS_API_KEY - 替换为你的 Helius API Key");
    console.log("   2. WALLETS 对象 - 替换为你的实际钱包地址");
    console.log("   3. 运行: bun test_all_wallets_enhanced.mjs");
    
  } catch (error) {
    console.error("❌ GBrain 测试失败:", error.message);
    process.exit(1);
  }
}

testGBrainConnection();
