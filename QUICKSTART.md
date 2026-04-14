# ⚡ GBrain + EvoHarness 快速参考

## 🔧 一分钟设置

```bash
cd /Users/aileen/RPCsol_pnl

# 1. 验证安装
bash harness/setup.sh

# 2. 配置 API Key
export HELIUS_API_KEY="your-helius-api-key"

# 3. 测试连接
bun test_gbrain_connection.mjs

# ✅ 完成！
```

---

## 📝 常用命令

### 测试单个钱包

```bash
# 语法：bun harness/router.mjs <address> <type>
bun harness/router.mjs 54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs sparse

# 输出：JSON 格式的结果
# {
#   "latency": 0.5,
#   "txCount": 42,
#   "surfaces": {...},
#   "score": 6.67
# }
```

### 批量测试多个钱包

```bash
# 编辑 test_all_wallets_enhanced.mjs
# 替换 HELIUS_API_KEY 和 WALLETS 对象
# 然后运行：

bun test_all_wallets_enhanced.mjs

# 结果自动写入 GBrain！
```

### 查询 GBrain 实验数据

```bash
# 列出所有实验
bun -x gbrain search "rpc-router"

# 查询特定钱包类型
bun -x gbrain search "mega wallet latency"

# 导出某个页面
bun -x gbrain get "experiments/rpc-router/sparse_1234567890"
```

### 启动 EvoHarness 进化

```bash
# 第一轮：光聚焦于 periodicChunking
python -m meta.run_iteration \
  --experiment-dir ./runs/rpc-router \
  --iteration 1 \
  --parent-variant baseline \
  --proposer-model haiku \
  --eval-model sonnet \
  --focus-surface periodicChunking \
  --harness-path ./harness

# 第二轮：进化所有 surfaces
python -m meta.run_iteration \
  --experiment-dir ./runs/rpc-router \
  --iteration 2 \
  --parent-variant best_v1 \
  --proposer-model haiku \
  --eval-model sonnet \
  --harness-path ./harness
```

---

## 🎯 6 个可进化参数

| 参数 | 当前值 | 范围 | 说明 |
|-----|--------|------|------|
| `periodicChunking` | 12 | 4-24 | Periodic 钱包分片数（越大越精确） |
| `megaHierarchical` | true | T/F | Mega 是否用递归分层 |
| `megaRecursionDepth` | 3 | 1-5 | 递归深度（控制细度） |
| `bandLogic` | "dynamic" | 3 选 | Band 选择逻辑 |
| `cacheStrategy` | "l0" | 3 选 | 缓存策略 |
| `maxConcurrent` | 8 | 1-32 | RPC 并发数 |

---

## 📊 评分公式

```
score = 10 / (1 + latency_seconds)

⭐⭐⭐⭐⭐ 目标：score >= 8.0
                 (latency <= 0.25s)
```

---

## 🗂️ 文件位置

```
RPCsol_pnl/
  test_all_wallets_enhanced.mjs    ← 批量测试脚本
  test_gbrain_connection.mjs        ← GBrain 验证
  harness/
    ├── router.mjs                  ← RPC 路由 + surfaces
    ├── agent.py                    ← EvoHarness 接口
    ├── setup.sh                    ← 初始化
    ├── README.md                   ← 详细文档
    └── surfaces/
        └── manifest.json           ← Surfaces 定义
  tools/
    └── gbrain/                     ← GBrain 子模块
  .gbrain/                          ← 数据库文件
  brain/rpc-router/                 ← 数据目录
  runs/rpc-router/                  ← 迭代结果
```

---

## 🚨 常见错误

| 错误 | 解决方案 |
|-----|---------|
| `HELIUS_API_KEY not found` | `export HELIUS_API_KEY="..."` |
| `Rate limit exceeded` | 减小 `maxConcurrent`（<=8 免费层） |
| `GBrain connection failed` | 运行 `bun test_gbrain_connection.mjs` |
| `Module not found: gbrain` | 运行 `bun link gbrain` |

---

## 💡 Pro Tips

1. **快速基线**：先运行 `test_gbrain_connection.mjs` 验证设置
2. **成本控制**：Helius 免费层 + Proposer 用 Haiku，Evaluator 用 Sonnet
3. **缓存优化**：启用 `cacheStrategy=l0-l1` 可显著降低重复查询的耗时
4. **Mega 钱包**：不要试图 `megaRecursionDepth > 5`（会超时）
5. **定期备份**：`.gbrain/*.pglite` 包含所有实验历史，commit 到 git 或备份到云

---

## 📞 快速链接

- 查看完整实施文档：[IMPLEMENTATION_COMPLETE.md](./IMPLEMENTATION_COMPLETE.md)
- Harness 详细文档：[harness/README.md](./harness/README.md)
- GBrain 官方：https://github.com/garrytan/gbrain
- EvoHarness 官方：https://github.com/ryanli-me/EvoHarness

---

**版本**：2.0 | **更新**：2026-04-14
