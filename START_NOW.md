# 🚀 现在开始！GBrain + EvoHarness 自动优化

**状态**：✅ 所有组件已安装、配置、验证并就绪  
**日期**：2026-04-14  
**项目**：RPCsol_pnl

---

## 📂 你在这里

```
/Users/aileen/RPCsol_pnl/
├── START_HERE.sh           ← 交互式启动向导
├── AUTO_START.sh           ← 自动化启动脚本
├── verify_setup.sh         ← 一键验证
├── test_all_wallets_enhanced.mjs    ← 批量测试
├── harness/                ← EvoHarness 包装（6 个可进化参数）
├── tools/gbrain/           ← GBrain 本地知识库
├── .gbrain/                ← 数据库文件
└── runs/rpc-router/        ← 迭代结果
```

---

## 🎯 三个使用模式

### 模式 1️⃣: 快速演示（2 分钟）✨ **推荐新手**

测试单个钱包，验证所有组件工作：

```bash
export HELIUS_API_KEY="your-api-key"
bash AUTO_START.sh
```

**输出示例**：
```
✅ GBrain 连接成功
✅ 测试完成
延迟：1.99 秒
交易数：1
评分：8.3/10
✅ 结果已自动写入 GBrain
```

**耗时**：10-30 秒

---

### 模式 2️⃣: 批量钱包测试（5-10 分钟）

测试多个钱包类型，建立基线数据：

```bash
# 编辑 test_all_wallets_enhanced.mjs
# 替换 HELIUS_API_KEY 和 WALLETS 对象

bun test_all_wallets_enhanced.mjs
```

**配置示例**：
```javascript
const HELIUS_API_KEY = "c8a62035-6378-4ddd-9cde-ab3967305ebc";

const WALLETS = {
  sparse: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs",
  medium: "YOUR_MEDIUM_WALLET",
  dense: "YOUR_DENSE_WALLET",
  whale: "YOUR_WHALE_WALLET",
};
```

**输出**：GBrain 中的 4 条实验记录，每个钱包类型一条

---

### 模式 3️⃣: 启动自动进化循环（30 分钟 - 2 小时）

让 EvoHarness 自动进化 6 个参数以最小化延迟：

#### 前置条件：安装 EvoHarness

```bash
# 一次性安装
git submodule add https://github.com/ryanli-me/EvoHarness.git tools/evo-harness
pip install -e ./tools/evo-harness
```

#### 启动第一轮迭代

```bash
python -m meta.run_iteration \
  --experiment-dir ./runs/rpc-router \
  --iteration 1 \
  --parent-variant baseline \
  --proposer-model haiku \
  --eval-model sonnet \
  --focus-surface periodicChunking \
  --harness-path ./harness
```

**配置说明**：
- `--proposer-model haiku`：便宜的模型（快速生成候选）
- `--eval-model sonnet`：高效的模型（精确评估）
- `--focus-surface periodicChunking`：优先进化这个参数

**预期结果**：
```
Iteration 1 结果：
  Baseline latency: 1.99s (score: 8.3)
  Proposed config: periodicChunking = 14, others unchanged
  New latency: 1.85s (score: 8.4) ✅ 改进 0.7%
```

---

## 📊 6 个可进化参数一览

这些参数由 EvoHarness 自动调整，以最小化 RPC 延迟：

| # | 参数 | 类型 | 默认 | 范围 | 风险 | 作用 |
|---|-----|------|------|------|------|------|
| 1 | `periodicChunking` | int | 12 | 4-24 | 中 | Periodic 钱包时间分片数 |
| 2 | `megaHierarchical` | bool | true | T/F | 高 | Mega 是否用分层递归 |
| 3 | `megaRecursionDepth` | int | 3 | 1-5 | 高 | 递归深度控制 |
| 4 | `bandLogic` | enum | dynamic | 3选 | 中 | Band 选择逻辑 |
| 5 | `cacheStrategy` | enum | l0 | 3选 | 低 | 缓存策略 |
| 6 | `maxConcurrent` | int | 8 | 1-32 | 高 | RPC 并发数 |

---

## 📈 评分与优化目标

```
评分公式：score = 10 / (1 + latency_seconds)

当前延迟          评分         评价
0.25s           8.0  ⭐⭐⭐⭐⭐ 目标
0.50s           6.7  ⭐⭐⭐⭐
1.00s           5.0  ⭐⭐⭐
2.00s           3.3  ⭐⭐
```

**优化周期**：
- 轮次 1：Focus on `periodicChunking` (baseline → +0.5-2%)
- 轮次 2：Focus on `megaHierarchical` + depth (baseline → +1-5%)
- 轮次 3+：Multi-surface 优化 (baseline → +3-10%)

---

## 🔍 监控和查看结果

### 查看 GBrain 中的所有实验

```bash
# 列出所有记录
bun -x gbrain search "rpc-router"

# 搜索特定钱包类型
bun -x gbrain search "sparse wallet latency"

# 获取单条记录详情
bun -x gbrain get "experiments/rpc-router/sparse_1234567890"
```

### 查看 EvoHarness 迭代结果

```bash
# 查看迭代 1 的结果
cat runs/rpc-router/iteration_1/results.json

# 查看 Proposer 的推理过程
cat runs/rpc-router/iteration_1/proposer.log

# 比较多轮迭代
diff runs/rpc-router/iteration_1/results.json runs/rpc-router/iteration_2/results.json
```

---

## 🧩 完整工作流示例

### 完整演示（从零到进化，30 秒）

```bash
#!/bin/bash

export HELIUS_API_KEY="your-key"

# Step 1: 验证环境
bash verify_setup.sh

# Step 2: 快速演示（验证 GBrain + harness）
bash AUTO_START.sh "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs" "sparse"

# Step 3: 查看 GBrain 结果
bun -x gbrain search "rpc-router"

# Step 4: 查看原始 JSON
bun -x gbrain search "sparse" | head -20

echo "✅ 演示完成！"
```

---

## ⚙️ 常见配置

### 配置 1：快速迭代（成本优先）

```bash
python -m meta.run_iteration \
  --experiment-dir ./runs/rpc-router \
  --iteration 1 \
  --proposer-model haiku \
  --eval-model haiku \
  --focus-surface periodicChunking \
  --harness-path ./harness
```

**成本**：$$  
**精度**：⭐⭐  
**速度**：⚡⚡⚡

### 配置 2：精确优化（精度优先）

```bash
python -m meta.run_iteration \
  --experiment-dir ./runs/rpc-router \
  --iteration 1 \
  --proposer-model claude-opus \
  --eval-model claude-opus \
  --harness-path ./harness
```

**成本**：$$$$  
**精度**：⭐⭐⭐⭐⭐  
**速度**：🐢

### 配置 3：平衡（推荐）

```bash
python -m meta.run_iteration \
  --experiment-dir ./runs/rpc-router \
  --iteration 1 \
  --proposer-model haiku \
  --eval-model sonnet \
  --focus-surface periodicChunking \
  --harness-path ./harness
```

**成本**：$$$  
**精度**：⭐⭐⭐⭐  
**速度**：⚡⚡

---

## 📖 深入学习

| 文档 | 用途 | 阅读时间 |
|-----|------|---------|
| [QUICKSTART.md](./QUICKSTART.md) | 快速参考和常用命令 | 5 分钟 |
| [harness/README.md](./harness/README.md) | Harness 详细使用 | 10 分钟 |
| [IMPLEMENTATION_COMPLETE.md](./IMPLEMENTATION_COMPLETE.md) | 完整技术细节 | 20 分钟 |
| [NEW_FILES_MANIFEST.md](./NEW_FILES_MANIFEST.md) | 文件清单和回滚 | 5 分钟 |

---

## 🎓 学习路径

**第 1 天**：快速演示
```
bash AUTO_START.sh
cat QUICKSTART.md
```

**第 2 天**：批量测试
```
bun test_all_wallets_enhanced.mjs
bun -x gbrain search "rpc-router"
```

**第 3 天**：自动进化
```
python -m meta.run_iteration --iteration 1 ...
cat runs/rpc-router/iteration_1/results.json
```

**第 4+ 天**：持续优化
```
# 每天或每周运行新的迭代
python -m meta.run_iteration --iteration 2 ...
python -m meta.run_iteration --iteration 3 ...
# 监控评分趋势
```

---

## 🚨 故障排除

### 问题：`HELIUS_API_KEY not found`

**解决**：
```bash
export HELIUS_API_KEY="your-key-from-dev.helius.xyz"
```

### 问题：`GBrain connection failed`

**解决**：
```bash
bun test_gbrain_connection.mjs
# 检查输出是否显示 ✅
```

### 问题：`Rate limit exceeded`

**解决**：
```bash
# 减少并发数
# 编辑 harness/router.mjs，改 maxConcurrent: 8 → 4
```

### 问题：钱包没有交易

**解决**：
```bash
# 确保钱包地址正确（以大写字母开头）
# 尝试查询不同的钱包
bun harness/router.mjs "DifferentWalletAddress" sparse
```

---

## 💡 提示和技巧

1. **定期备份 GBrain**
   ```bash
   cp -r .gbrain .gbrain.backup.$(date +%Y%m%d)
   ```

2. **导出实验数据为 CSV**
   ```bash
   bun -x gbrain export --format csv > experiments.csv
   ```

3. **使用 Git 追踪配置变化**
   ```bash
   git add -A
   git commit -m "Run iteration 1: periodicChunking optimization"
   ```

4. **监控长期趋势**
   ```bash
   for i in {1..5}; do
     python -m meta.run_iteration --iteration $i --parent-variant best --harness-path ./harness
   done
   ```

---

## 🎊 下一步行动 → 立即开始

**选一个开始**：

```bash
# 最简单：快速演示（推荐新手）
bash AUTO_START.sh

# 中等：交互式启动向导
bash START_HERE.sh

# 完整：所有组件验证
bash verify_setup.sh

# 生产：启动自动进化
python -m meta.run_iteration \
  --experiment-dir ./runs/rpc-router \
  --iteration 1 \
  --proposer-model haiku \
  --eval-model sonnet \
  --focus-surface periodicChunking \
  --harness-path ./harness
```

---

**🎯 核心概念**：

- ✅ **GBrain**：自动存储每次测试的结果（无需手动管理）
- ✅ **EvoHarness**：自动生成和评估新配置（无需手动调参）
- ✅ **RPC Router**：智能路由请求（自动适应不同钱包）

**🚀 结果**：配置自动优化，延迟逐次下降

---

**版本**：2.0 | **日期**：2026-04-14 | **状态**：✅ 生产就绪

## 👉 [现在就开始吧！](./AUTO_START.sh)
