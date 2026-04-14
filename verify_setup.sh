#!/bin/bash
# verify_setup.sh - 完整的安装验证脚本

echo "🔍 GBrain + EvoHarness 安装验证"
echo "=================================="
echo ""

PASS=0
FAIL=0

check_file() {
    if [ -f "$1" ]; then
        echo "✅ $1"
        ((PASS++))
    else
        echo "❌ $1"
        ((FAIL++))
    fi
}

check_dir() {
    if [ -d "$1" ]; then
        echo "✅ $1"
        ((PASS++))
    else
        echo "❌ $1"
        ((FAIL++))
    fi
}

check_command() {
    if command -v "$1" &> /dev/null; then
        echo "✅ $1 ($(which $1))"
        ((PASS++))
    else
        echo "❌ $1"
        ((FAIL++))
    fi
}

echo "📝 文件检查："
check_file "test_all_wallets_enhanced.mjs"
check_file "test_gbrain_connection.mjs"
check_file "harness/router.mjs"
check_file "harness/agent.py"
check_file "harness/setup.sh"
check_file "harness/surfaces/manifest.json"
check_file "package.json"
check_file "IMPLEMENTATION_COMPLETE.md"
check_file "QUICKSTART.md"
check_file "NEW_FILES_MANIFEST.md"

echo ""
echo "📁 目录检查："
check_dir "tools/gbrain"
check_dir "harness"
check_dir "harness/surfaces"
check_dir ".gbrain"
check_dir "runs/rpc-router"

echo ""
echo "🛠️  工具检查："
check_command "bun"
check_command "python3"
check_command "node"

echo ""
echo "📊 脚本大小："
wc -l test_all_wallets_enhanced.mjs harness/router.mjs harness/agent.py | tail -1

echo ""
echo "📚 文档简览："
echo "  - IMPLEMENTATION_COMPLETE.md: 完整实施总结"
echo "  - QUICKSTART.md: 快速参考和常用命令"
echo "  - harness/README.md: Harness 使用文档"
echo "  - NEW_FILES_MANIFEST.md: 新增文件清单"

echo ""
echo "=================================="
if [ $FAIL -eq 0 ]; then
    echo "✅ 验证完成！所有组件就绪。"
    echo ""
    echo "📖 后续步骤（参考 QUICKSTART.md）："
    echo "  1. export HELIUS_API_KEY='your-key'"
    echo "  2. bun test_gbrain_connection.mjs"
    echo "  3. bun test_all_wallets_enhanced.mjs"
    echo "  4. python -m meta.run_iteration --experiment-dir ./runs/rpc-router ..."
    exit 0
else
    echo "❌ 验证失败！共 $FAIL 个问题。"
    echo "请检查上面标记为❌的项目。"
    exit 1
fi
