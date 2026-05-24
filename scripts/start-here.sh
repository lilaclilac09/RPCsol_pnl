#!/bin/bash
# START_HERE.sh - 启动 GBrain + EvoHarness 自动优化

set -e

echo ""
echo "╔════════════════════════════════════════════════════════════════════════════╗"
echo "║        🚀 GBrain + EvoHarness RPC Router 自动优化启动器                    ║"
echo "╚════════════════════════════════════════════════════════════════════════════╝"
echo ""

# 第一步：验证环境
echo "📋 第一步：验证环境..."
bash verify_setup.sh || {
    echo "❌ 环境验证失败。请检查上面的错误信息。"
    exit 1
}

echo ""
echo "════════════════════════════════════════════════════════════════════════════"
echo ""

# 第二步：检查 HELIUS_API_KEY
echo "🔑 第二步：配置 HELIUS_API_KEY..."
if [ -z "$HELIUS_API_KEY" ]; then
    echo "❌ HELIUS_API_KEY 未设置"
    echo ""
    echo "请提供你的 Helius API Key："
    echo "  1. 访问 https://dev.helius.xyz"
    echo "  2. 复制你的 API Key"
    echo "  3. 运行："
    echo ""
    echo "     export HELIUS_API_KEY='your-api-key'"
    echo "     bash START_HERE.sh"
    echo ""
    exit 1
else
    echo "✅ HELIUS_API_KEY 已配置: ${HELIUS_API_KEY:0:10}..."
fi

echo ""
echo "════════════════════════════════════════════════════════════════════════════"
echo ""

# 第三步：选择操作模式
echo "🎯 第三步：选择操作模式..."
echo ""
echo "1️⃣  快速演示（10 秒）"
echo "   - 测试单个钱包连接"
echo "   - 验证 GBrain ingest"
echo "   - 无需实际参数进化"
echo ""
echo "2️⃣  运行第一轮 EvoHarness"
echo "   - Proposer: Haiku（便宜）"
echo "   - Evaluator: Sonnet"
echo "   - 时间：10-30 分钟"
echo ""
echo "3️⃣  只设置，不运行"
echo "   - 验证所有组件"
echo "   - 显示后续命令"
echo ""

read -p "选择 (1/2/3)? " choice

case $choice in
    1)
        echo ""
        echo "🔧 启动快速演示..."
        echo ""
        echo "需要一个 Solana 钱包地址（例如 54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs）"
        read -p "输入钱包地址: " wallet_addr
        
        if [ -z "$wallet_addr" ]; then
            echo "❌ 钱包地址不能为空"
            exit 1
        fi
        
        echo ""
        echo "🧪 测试 GBrain 连接..."
        bun test_gbrain_connection.mjs
        
        echo ""
        echo "🧪 测试 harness router..."
        export HELIUS_API_KEY
        bun harness/router.mjs "$wallet_addr" sparse
        
        echo ""
        echo "✅ 快速演示完成！"
        echo ""
        echo "✨ 后续步骤："
        echo "   编辑 test_all_wallets_enhanced.mjs"
        echo "   替换 HELIUS_API_KEY 和 WALLETS"
        echo "   运行: bun test_all_wallets_enhanced.mjs"
        ;;
    
    2)
        echo ""
        echo "🚀 准备 EvoHarness 第一轮迭代..."
        echo ""
        
        # 检查是否有 EvoHarness
        if ! command -v python -m meta.run_iteration &> /dev/null && ! [ -d "tools/evo-harness" ]; then
            echo "⚠️  EvoHarness 尚未安装"
            echo ""
            echo "安装步骤："
            echo "  1. git submodule add https://github.com/ryanli-me/EvoHarness.git tools/evo-harness"
            echo "  2. pip install -e ./tools/evo-harness"
            echo ""
            read -p "现在安装？(y/n) " -n 1 -r install_choice
            echo
            if [[ $install_choice =~ ^[Yy]$ ]]; then
                echo "📦 正在安装 EvoHarness..."
                git submodule add https://github.com/ryanli-me/EvoHarness.git tools/evo-harness
                pip install -e ./tools/evo-harness
                echo "✅ EvoHarness 已安装"
            else
                echo "⏭️  跳过 EvoHarness 安装"
                exit 0
            fi
        fi
        
        echo ""
        echo "📊 EvoHarness 第一轮配置："
        echo "  - Iteration: 1"
        echo "  - Proposer Model: haiku（便宜）"
        echo "  - Evaluator Model: sonnet（高效）"
        echo "  - Focus Surface: periodicChunking"
        echo ""
        
        echo "需要选定钱包类型进行评估："
        echo "  • sparse: 交易少（<50）- 快速测试"
        echo "  • periodic: 跨度大但交易少 - 中等测试"
        echo "  • mega: 交易非常多（>10k）- 完整测试"
        echo ""
        read -p "选择钱包类型 (sparse/periodic/mega)? " wallet_type
        wallet_type=${wallet_type:-sparse}
        
        echo ""
        echo "需要测试钱包地址："
        read -p "输入钱包地址: " test_wallet
        
        if [ -z "$test_wallet" ]; then
            echo "❌ 钱包地址不能为空"
            exit 1
        fi
        
        echo ""
        echo "🎬 启动 EvoHarness iteration 1..."
        echo ""
        
        export HELIUS_API_KEY
        export TEST_WALLET=$test_wallet
        export TEST_WALLET_TYPE=$wallet_type
        
        python -m meta.run_iteration \
            --experiment-dir ./runs/rpc-router \
            --iteration 1 \
            --parent-variant baseline \
            --proposer-model haiku \
            --eval-model sonnet \
            --focus-surface periodicChunking \
            --harness-path ./harness \
            --eval-params "{\"wallet_address\": \"$test_wallet\", \"wallet_type\": \"$wallet_type\"}"
        
        echo ""
        echo "✅ EvoHarness iteration 1 完成！"
        echo ""
        echo "📊 查看结果："
        echo "   cat runs/rpc-router/iteration_1/results.json"
        echo "   cat runs/rpc-router/iteration_1/proposer.log"
        ;;
    
    3)
        echo ""
        echo "✅ 设置完成！所有组件已验证。"
        echo ""
        echo "📖 后续命令："
        echo ""
        echo "【运行单个测试】"
        echo "  bun harness/router.mjs <wallet-address> sparse"
        echo ""
        echo "【批量钱包测试】"
        echo "  # 编辑 test_all_wallets_enhanced.mjs 配置 HELIUS_API_KEY 和 WALLETS"
        echo "  bun test_all_wallets_enhanced.mjs"
        echo ""
        echo "【启动 EvoHarness 进化】"
        echo "  python -m meta.run_iteration \\"
        echo "    --experiment-dir ./runs/rpc-router \\"
        echo "    --iteration 1 \\"
        echo "    --parent-variant baseline \\"
        echo "    --proposer-model haiku \\"
        echo "    --eval-model sonnet \\"
        echo "    --focus-surface periodicChunking \\"
        echo "    --harness-path ./harness"
        echo ""
        echo "【查看 GBrain 结果】"
        echo "  bun -x gbrain search \"rpc-router\""
        echo ""
        echo "【查看完整文档】"
        echo "  cat QUICKSTART.md"
        echo "  cat IMPLEMENTATION_COMPLETE.md"
        ;;
    
    *)
        echo "❌ 无效选择"
        exit 1
        ;;
esac

echo ""
echo "════════════════════════════════════════════════════════════════════════════"
echo "✨ 开始你的自动优化之旅！"
echo ""
