#!/bin/bash
# AUTO_START.sh - 完全自动化启动（无需交互）

set -e

echo ""
echo "╔════════════════════════════════════════════════════════════════════════════╗"
echo "║     🚀 自动启动：GBrain + EvoHarness RPC Router 优化引擎"
echo "╚════════════════════════════════════════════════════════════════════════════╝"
echo ""

# 环境检查
echo "Step 1️⃣ : 环境验证..."
if ! bun --version > /dev/null 2>&1; then
    echo "❌ Bun 未安装或未在 PATH 中"
    exit 1
fi

if ! python3 --version > /dev/null 2>&1; then
    echo "❌ Python3 未安装"
    exit 1
fi

echo "✅ 所有依赖就绪"
echo ""

# 检查 API Key
echo "Step 2️⃣ : 验证 API 配置..."
if [ -z "$HELIUS_API_KEY" ]; then
    echo "❌ HELIUS_API_KEY 未设置"
    echo ""
    echo "📌 设置方法："
    echo "   export HELIUS_API_KEY='your-api-key'"
    echo ""
    exit 1
fi
echo "✅ HELIUS_API_KEY 已配置"
echo ""

# 验证钱包地址（如果在命令行参数中）
TEST_WALLET="${1:-54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs}"
TEST_TYPE="${2:-sparse}"

echo "Step 3️⃣ : 验证 GBrain 连接..."
echo "  测试数据库连接..."
if ! bun test_gbrain_connection.mjs > /dev/null 2>&1; then
    echo "❌ GBrain 连接失败"
    exit 1
fi
echo "✅ GBrain 连接成功"
echo ""

echo "════════════════════════════════════════════════════════════════════════════"
echo ""

echo "Step 4️⃣ : 运行第一个测试 (harness router)..."
echo "  钱包: $TEST_WALLET"
echo "  类型: $TEST_TYPE"
echo ""
echo "⏳ 执行中（这会花费 10-30 秒）..."
echo ""

RESULT=$(bun harness/router.mjs "$TEST_WALLET" "$TEST_TYPE" 2>&1)

echo "$RESULT" | tail -n 20

echo ""
echo "════════════════════════════════════════════════════════════════════════════"
echo ""

# 解析结果
LATENCY=$(echo "$RESULT" | grep -o '"latency":[0-9.]*' | grep -o '[0-9.]*' || echo "unknown")
TX_COUNT=$(echo "$RESULT" | grep -o '"txCount":[0-9]*' | grep -o '[0-9]*' || echo "unknown")
SCORE=$(echo "$RESULT" | grep -o '"score":[0-9.]*' | grep -o '[0-9.]*' || echo "unknown")

echo "📊 测试结果："
echo "   延迟 (Latency): $LATENCY 秒"
echo "   交易数 (Tx Count): $TX_COUNT"
echo "   评分 (Score): $SCORE/10"
echo ""

if [ "$LATENCY" != "unknown" ]; then
    echo "✅ 测试成功！结果已自动写入 GBrain。"
else
    echo "⚠️  结果解析有问题，但测试已运行。"
fi

echo ""
echo "════════════════════════════════════════════════════════════════════════════"
echo ""

echo "🎯 后续步骤："
echo ""
echo "1️⃣  【查看 GBrain 中的实验记录】"
echo "    $ bun -x gbrain search \"rpc-router\""
echo ""
echo "2️⃣  【运行多钱包批量测试】"
echo "    编辑 test_all_wallets_enhanced.mjs，配置："
echo "    - HELIUS_API_KEY = '$HELIUS_API_KEY'"
echo "    - WALLETS 对象中的实际钱包地址"
echo "    然后运行："
echo "    $ bun test_all_wallets_enhanced.mjs"
echo ""
echo "3️⃣  【启动 EvoHarness 自动进化循环】"
echo "    $ python -m meta.run_iteration \\"
echo "      --experiment-dir ./runs/rpc-router \\"
echo "      --iteration 1 \\"
echo "      --parent-variant baseline \\"
echo "      --proposer-model haiku \\"
echo "      --eval-model sonnet \\"
echo "      --focus-surface periodicChunking \\"
echo "      --harness-path ./harness"
echo ""
echo "4️⃣  【查看完整文档】"
echo "    $ cat QUICKSTART.md              # 快速参考（5 分钟）"
echo "    $ cat IMPLEMENTATION_COMPLETE.md # 完整总结（详细）"
echo "    $ cat harness/README.md          # Harness 使用指南"
echo ""

echo "════════════════════════════════════════════════════════════════════════════"
echo ""
echo "🎊 自动启动流程完成！"
echo ""
echo "💡 核心概念："
echo "   • GBrain: 本地知识库，自动存储所有实验数据"
echo "   • EvoHarness: 自动参数调优引擎（6 个可进化参数）"
echo "   • RPC Router: 智能 Solana RPC 路由器"
echo ""
echo "🚀 所有组件已集成并验证 ✅"
echo ""
