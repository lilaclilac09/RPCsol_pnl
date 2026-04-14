# EvoHarness RPC Router Optimization

这个目录包含 RPC 路由器的 EvoHarness 优化配置。

## 目录结构

```
harness/
  router.mjs              ← RPC 路由器核心逻辑（包含可进化的 surfaces）
  agent.py               ← EvoHarness Python 入口（Proposer + Evaluator 调用这个）
  surfaces/
    manifest.json        ← Surfaces 清单（告诉 EvoHarness 哪些参数可进化）
  README.md              ← 本文件
```

## 快速开始

### 1. 验证 harness 工作

```bash
cd /path/to/RPCsol_pnl

# 测试 Python agent（列出 surfaces）
python harness/agent.py

# 测试某个钱包（需要配置 HELIUS_API_KEY）
export HELIUS_API_KEY="your-api-key"
bun harness/router.mjs <wallet-address> sparse
```

### 2. 启动 EvoHarness 进化循环

```bash
# 假设你已经安装了 EvoHarness
# git submodule add https://github.com/ryanli-me/EvoHarness.git tools/evo-harness
# pip install ./tools/evo-harness

cd /path/to/RPCsol_pnl

# 第一次迭代（Proposer 用便宜模型，Evaluator 用较强模型）
python -m meta.run_iteration \
  --experiment-dir ./runs/rpc-router \
  --iteration 1 \
  --parent-variant baseline \
  --proposer-model haiku \
  --eval-model sonnet \
  --focus-surface periodicChunking \
  --harness-path ./harness

# 第二次迭代（迭代所有 surfaces）
python -m meta.run_iteration \
  --experiment-dir ./runs/rpc-router \
  --iteration 2 \
  --parent-variant best_v1 \
  --proposer-model haiku \
  --eval-model sonnet \
  --harness-path ./harness
```

## Surfaces（可进化参数）

| Surface | 类型 | 默认值 | 范围/选项 | 风险 | 说明 |
|---------|------|--------|---------|------|------|
| `periodicChunking` | int | 12 | 4-24 | 中 | Periodic wallet 时间分片数：小=快但精度低，大=精确但调用多 |
| `megaHierarchical` | bool | true | true/false | 高 | Mega wallet 是否用分层递归（vs 简单均匀分片） |
| `megaRecursionDepth` | int | 3 | 1-5 | 高 | Mega wallet 递归深度：控制分层查询细度 |
| `bandLogic` | enum | "dynamic" | dynamic/fixed/adaptive | 中 | Band 选择逻辑：dynamic=自适应，fixed=8块，adaptive=学习最优 |
| `cacheStrategy` | enum | "l0" | none/l0/l0-l1 | 低 | 缓存策略：none=无，l0=token缓存，l0-l1=多层缓存 |
| `maxConcurrent` | int | 8 | 1-32 | 高 | RPC并发调用数：高=快但可能rate limit |

## 评分方式

评分公式：`score = 10 / (1 + latency_seconds)`

示例：
- 0.5s 延迟 → 6.67 分
- 1.0s 延迟 → 5.0 分
- 2.0s 延迟 → 3.33 分

**目标**：`score >= 8.0` (对应 <= 0.25s 延迟)

## GBrain 集成

每次 EvoHarness 评估一个配置，结果会自动写入 GBrain：

```bash
# 查看所有实验结果
bun -x gbrain s experiments/

# 查询某个钱包类型的最好配置
bun -x gbrain s "mega wallet latency"
```

## 测试数据

有三个预配置的测试集：

### Quick Eval（快速评估）
- 钱包：sparse, medium, dense
- 预算：100 RPC 调用
- 用途：快速迭代时的有效性检查

### Standard Eval（标准评估）
- 钱包：sparse, medium, dense, whale
- 预算：300 RPC 调用
- 用途：验证一般性能

### Comprehensive Eval（综合评估）
- 钱包：sparse, medium, dense, whale, periodic, mega
- 预算：500 RPC 调用
- 用途：最终性能验证

## 常见坑

### 1. Rate Limit
Helius 免费层：最多 10 并发，建议 `maxConcurrent <= 8`
Helius 付费层：最多 40 并发，可以推到 32

### 2. Mega Wallet 爆炸
`megaRecursionDepth > 4` 可能导致指数级 RPC 调用。从 3 开始，谨慎递增。

### 3. Cache 不一致
如果启用 `cacheStrategy=l0-l1` 但钱包活动频繁，缓存可能过期。需要定期清理。

## 日志和调试

```bash
# 查看最新的进化结果
cat runs/rpc-router/iteration_2/results.json

# 查看 Proposer 的推理过程
cat runs/rpc-router/iteration_2/proposer.log

# 查看 GBrain 中的所有实验
bun -x gbrain search "rpc-router"
```

## 进阶：自定义 Proposer

你可以在 `harness/proposers/` 下创建自定义 proposer：

```bash
mkdir -p harness/proposers
cat > harness/proposers/my_proposer.py << 'EOF'
# 自定义 proposer 逻辑
def propose_next_config(history, gbrainQuery):
    # 查询 GBrain 的历史结果
    results = gbrainQuery("experiments/rpc-router")
    
    # 基于历史选择下一个配置
    best = max(results, key=lambda x: x["score"])
    next_config = {
        "periodicChunking": best["periodicChunking"] + 1,  # 微调
        ...
    }
    return next_config
EOF
```

## 参考

- [EvoHarness 文档](https://github.com/ryanli-me/EvoHarness)
- [GBrain 文档](https://github.com/garrytan/gbrain)
- [Helius API 最佳实践](https://docs.helius.xyz/)
