#!/bin/bash
# harness/setup.sh
# EvoHarness RPC Router 快速初始化脚本

set -e

echo "🚀 EvoHarness RPC Router Setup"
echo ""

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# 检查必要的工具
echo "1️⃣  检查环境..."
if ! command -v bun &> /dev/null; then
    echo "❌ 需要 Bun。安装: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi
echo "   ✅ Bun: $(bun --version)"

if ! command -v python3 &> /dev/null; then
    echo "❌ 需要 Python 3"
    exit 1
fi
echo "   ✅ Python: $(python3 --version)"

# 检查 HELIUS_API_KEY
echo ""
echo "2️⃣  配置 API 密钥..."
if [ -z "$HELIUS_API_KEY" ]; then
    echo "   ⚠️  HELIUS_API_KEY 未设置"
    echo "   提供你的 Helius API Key（来自 https://dev.helius.xyz）："
    read -p "   HELIUS_API_KEY: " HELIUS_API_KEY
    if [ -z "$HELIUS_API_KEY" ]; then
        echo "❌ API Key 必需"
        exit 1
    fi
    # 保存到 .env
    echo "HELIUS_API_KEY=$HELIUS_API_KEY" > "$REPO_ROOT/.env.local"
    echo "   ✅ API Key 已保存到 .env.local"
else
    echo "   ✅ HELIUS_API_KEY 已配置"
fi

# 验证 GBrain
echo ""
echo "3️⃣  验证 GBrain..."
if ! test -d "$REPO_ROOT/.gbrain"; then
    echo "   ⚠️  GBrain 数据库不存在，初始化..."
    mkdir -p "$REPO_ROOT/.gbrain"
fi
if [ -f "$REPO_ROOT/.gbrain/rpc-router.pglite" ]; then
    echo "   ✅ GBrain 数据库已存在"
else
    echo "   ℹ️  GBrain 数据库将在第一次运行时创建"
fi

# 创建 runs 目录
echo ""
echo "4️⃣  创建运行目录..."
mkdir -p "$REPO_ROOT/runs/rpc-router"
echo "   ✅ runs/rpc-router 已准备"

# 测试 harness 脚本
echo ""
echo "5️⃣  测试 harness..."
export HELIUS_API_KEY
# 不实际测试钱包，只验证脚本可以导入
if python3 -c "import sys; sys.path.insert(0, '$REPO_ROOT/harness'); from agent import RouterHarness; print('✅ Python agent 可导入')" 2>/dev/null; then
    echo "   ✅ Python agent 配置正确"
else
    echo "   ⚠️  Python agent 导入失败，但可能是依赖问题"
fi

# 打印后续步骤
echo ""
echo "✅ 初始化完成！"
echo ""
echo "📋 后续步骤："
echo ""
echo "1. 选择一个钱包测试:"
echo "   export HELIUS_API_KEY='your-key'"
echo "   bun harness/router.mjs <wallet-address> sparse"
echo ""
echo "2. 启动 EvoHarness 进化循环:"
echo "   python -m meta.run_iteration \\"
echo "     --experiment-dir ./runs/rpc-router \\"
echo "     --iteration 1 \\"
echo "     --parent-variant baseline \\"
echo "     --proposer-model haiku \\"
echo "     --eval-model sonnet \\"
echo "     --harness-path ./harness"
echo ""
echo "3. 查看结果:"
echo "   ls -la runs/rpc-router/"
echo "   cat runs/rpc-router/iteration_1/results.json"
echo ""
echo "📖 更多信息: cat harness/README.md"
