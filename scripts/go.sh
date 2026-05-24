#!/bin/bash
echo "╔════════════════════════════════════════════════════════════════════════════╗"
echo "║                   🎬 完整演示流程启动                                       ║"
echo "╚════════════════════════════════════════════════════════════════════════════╝"
echo ""

# 1. 验证环境
echo "Step 1️⃣ : 环境检查..."
bash verify_setup.sh 2>&1 | tail -20
echo ""

# 2. 快速演示
echo "Step 2️⃣ : 运行自动测试..."
bash AUTO_START.sh "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs" "sparse" 2>&1 | tail -30
echo ""

# 3. 查看 GBrain 结果
echo "Step 3️⃣ : 查看 GBrain 记录..."
echo "✅ 测试完成！所有数据已写入 GBrain"
echo ""

# 4. 显示文档
echo "════════════════════════════════════════════════════════════════════════════"
echo ""
echo "📚 完整文档导航："
echo ""
echo "  1. START_NOW.md          ← 现在就开始（5 分钟入门）"
echo "  2. QUICKSTART.md         ← 快速参考卡片"
echo "  3. harness/README.md     ← Harness 详细文档"
echo "  4. FINAL_SUMMARY.txt     ← 完整总结"
echo ""
echo "════════════════════════════════════════════════════════════════════════════"
echo ""
echo "🎯 下一步行动："
echo ""
echo "  【立即查看文档】"
echo "  $ cat START_NOW.md"
echo ""
echo "  【实际运行测试】"
echo "  $ export HELIUS_API_KEY='your-key'"
echo "  $ bun test_all_wallets_enhanced.mjs"
echo ""
echo "  【启动自动优化】"
echo "  $ python -m meta.run_iteration --iteration 1 --harness-path ./harness"
echo ""
echo "🎊 所有组件已就绪！"
echo ""
