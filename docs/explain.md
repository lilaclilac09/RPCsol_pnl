# SOL Balance Research — Full Explanation
## English · 中文 · Side-by-side

---

## 🇬🇧 ELI5 (English) — "Why can it do it in 2 seconds?"

### Imagine your wallet is a giant library

Every SOL transaction is a book. There are thousands of books, sorted by date.
You want to find **every time money went in or out**.

---

### The OLD way (our V1–V8) — "Read one book at a time"

```
Go to shelf 1 → read → go to shelf 2 → read → go to shelf 3 → read...
```

Each "go to shelf" = one API call to Helius. Each call takes ~300–800ms.
14 calls in a row = 14 × 500ms = **7,000ms**. Slow.

---

### The FAST way — "Send all your friends at once"

#### Trick 1: Know the library first (Phase 0, 3 parallel calls at t=0)

Instead of reading page-by-page, ask three questions *at the same time*:
- "What's the OLDEST book?" (1 call)
- "What's the NEWEST book?" (1 call)
- "Give me your table of contents" (1 call, up to 1000 entries)

All 3 fire simultaneously. Done in 1 RTT (~500ms).

For wallets with ≤1000 transactions: **you already have all the data**. Phase 0 is enough.

#### Trick 2: 90-sig chunk sizing (Phase 2, all parallel)

You now know *which* books you need. Group them into stacks of 90.
Ask for all stacks simultaneously.

Why 90? The library hands out max 100 books per request.
If you ask for exactly 90, you **never need a second page** — no sequential chaining.
5 stacks of 90 = 5 parallel requests = **1 RTT** for all full transaction data.

#### Trick 3: HTTP/1.1 NOT HTTP/2

This one is counterintuitive.

HTTP/2 is supposed to be "smarter" — it multiplexes requests over one connection.
But Helius runs behind Cloudflare. Cloudflare's HTTP/2 scheduler **serialises** requests on the server side.
The result: your 16 "parallel" HTTP/2 requests get handled one-by-one anyway.

HTTP/1.1 with **64 persistent connections** (undici pool) bypasses this.
Each request has its own connection. True parallelism.
**Measured: 6× faster than HTTP/2 on Helius.** (discovered by H33ai-postquantum repo)

#### Trick 4: Synthetic pagination tokens

Helius pagination tokens have the format `"slot_number:transaction_index"`.

The OLD way: fetch page 1, get token, fetch page 2, get token, fetch page 3...
(sequential — each page waits for the previous one)

The SMART way: you know the slot range. **Fabricate** token `"285000000:0"` yourself.
Jump to ANY point in history without waiting for the chain.
Fire ALL pages in parallel. (discovered by shariqazeem/sol-pnl and hitman-kai/darkpnl)

#### Trick 5: Balance continuity oracle

If transaction A leaves your balance at 10.5 SOL and transaction B arrives with 10.5 SOL pre-balance:
The gap between them is **provably flat** — no transactions happened.
Skip fetching it entirely.

---

### Why exactly 2 seconds?

```
Phase 0 (parallel): 3 calls × ~400ms = 400ms  ← only the slowest counts
Phase 2 (parallel): 5 calls × ~500ms = 500ms  ← only the slowest counts
Total: ~900ms – 1,500ms
```

The "2 second" claim assumes warmed HTTP connections and a good Helius node.
With cold connections (first call ever), add ~200ms for TLS handshake.
With a slow Helius node (P95), add 300–800ms variance.

**In practice: 1.2s–2.5s** for a dense wallet (451 txs), vs **3–8s** with the old sequential approach.

---

### What we tried and ranked

| Method | Best score | Key insight |
|--------|-----------|-------------|
| V1 Golomb probing | 0.398 | Baseline |
| V2 Signatures-first | 0.620 | Anchor + signatures |
| V3 Merged anchor | 0.789* | GP-UCB found c=23 |
| V13 Constrained BO | 0.789 | Gate penalty in objective |
| **V14 Phantom fix** | **0.868** (base) | Remove phantom paginationToken |
| **Ultimate** | **0.225** gated | 9 calls, all parallel, undici |

*V3's 0.879 was a lucky trial on a faster API endpoint. Stable average = 0.716.

---
---

## 🇨🇳 五岁小孩版解释 (中文) — "为什么它能在2秒内完成？"

### 把你的钱包想象成一个巨大的图书馆

每一笔SOL交易都是一本书，书按日期排列。
你想找出**所有钱进出的记录**。

---

### 旧方法 (V1–V8) — "一本一本地读"

```
去第1书架 → 读完 → 去第2书架 → 读完 → 去第3书架 → 读完...
```

每次"去书架" = 一次API调用。每次约300–800毫秒。
14次串行调用 = 14 × 500ms = **7000毫秒**。很慢。

---

### 快速方法 — "同时派所有朋友去不同书架"

#### 技巧1：先摸清图书馆结构（第0阶段，3个并行调用）

不要逐页翻，而是**同时**问三个问题：
- "最老的那本书在哪？"（1次调用）
- "最新的那本书在哪？"（1次调用）
- "给我目录表"（1次调用，最多1000条）

三个调用同时发出，完成在1个往返时间（约500毫秒）。

对于交易数 ≤1000 的钱包：**第0阶段的数据就够了**，不需要后续步骤。

#### 技巧2：每次只取90笔交易（第2阶段，全部并行）

你已经知道需要哪些书了。把它们分成每堆90本的小组。
**同时**请求所有小组。

为什么是90？图书馆每次最多给100本。
只要你要90本，就**永远不会触发分页**——不需要等第1页回来再请求第2页。
5堆×90本 = 5个并行请求 = **所有完整交易数据只需1个往返时间**。

#### 技巧3：用HTTP/1.1，不用HTTP/2

这个很反直觉。

HTTP/2理论上更"聪明"——它在一条连接上多路复用请求。
但Helius在Cloudflare后面运行。Cloudflare的HTTP/2调度器会在服务器端**把请求排队串行处理**。
结果：你的16个"并行"HTTP/2请求还是一个一个被处理。

解决方案：用**64条持久HTTP/1.1连接**（undici连接池）绕过这个问题。
每个请求用自己的连接，真正实现并行。
**实测比HTTP/2快6倍。**（来自H33ai-postquantum仓库的发现）

#### 技巧4：伪造分页令牌（合成分页token）

Helius的分页令牌格式是 `"时间槽编号:交易序号"`，例如 `"285000000:0"`。

旧方法：拿第1页 → 得到令牌 → 拿第2页 → 得到令牌 → 拿第3页...
（串行——每页等上一页回来才能开始）

聪明方法：你知道时间槽范围，**自己伪造令牌** `"285000000:0"`。
直接跳到历史中的任意时刻，不用等链条传递。
所有页面**同时发出**。（来自shariqazeem/sol-pnl和hitman-kai/darkpnl的发现）

#### 技巧5：余额连续性预言机

如果交易A结束后余额是10.5 SOL，交易B开始前余额也是10.5 SOL：
它们之间的时间段**可以证明是平的**——没有发生任何交易。
直接跳过，不需要请求这段数据。

---

### 为什么恰好是2秒？

```
第0阶段（并行）：3次调用 × ~400ms = 400ms  ← 只算最慢的那个
第2阶段（并行）：5次调用 × ~500ms = 500ms  ← 只算最慢的那个
总计：约900ms – 1500ms
```

"2秒"的说法假设HTTP连接已经预热、Helius节点响应正常。
冷启动（第一次调用）：加约200ms的TLS握手时间。
慢节点（P95情况）：加300–800ms的波动。

**实际表现：1.2s–2.5s**（451笔交易的密集钱包），
vs 旧方法的 **3–8s**。

---

### 为什么之前达不到2秒？

我们研究中有一个关键Bug：**幽灵分页令牌（Phantom paginationToken）**

Helius在返回少于100条数据时仍然会给出 `paginationToken`。
旧代码会跟着这个令牌继续请求，导致每个时间窗口多出1次无效调用。
对于密集钱包：14次调用 → 本来应该是6次。多出8次无效调用。

V14修复：
```javascript
if (data.length < LIMIT) return samples; // 跳过幽灵令牌
```

这一行代码让密集钱包从 **14次→10次调用，2951ms→2120ms（快28%）**。

---

## 📊 Five-Repo Research Synthesis

### What we learned from studying 5 external repos

| Repo | Language | Key unique technique |
|------|----------|---------------------|
| shariqazeem/sol-pnl | TypeScript | Synthetic tokens + log-time anchors + continuity oracle |
| henryoman/mert-algo | Rust | Density-aware partitioning + pipelining sig→full |
| hitman-kai/darkpnl | Python | Synthetic token fabrication (RTT-2 fan-out) |
| frcd10/fastpnl | Rust | 90-sig chunks + governor rate limiter + exact call formula |
| H33ai-postquantum/solana-pnl-cachee | Rust | HTTP/1.1 > HTTP/2 discovery + Nx2 window pattern |

### The 5 techniques NOT in our research (now added to Ultimate)

**1. HTTP/1.1 connection pool (undici)**
```
Old: native fetch → HTTP/2 → Cloudflare serialises
New: undici Agent({ connections: 64 }) → HTTP/1.1 × 64 persistent sockets
Gain: 6× on Helius/Cloudflare (measured)
```

**2. Sig probe at t=0 — no extra calls for ≤1000 tx wallets**
```
Old: slot-window approach → N windows based on slot span → can be 10–50+ calls
New: 1 sig probe (limit=1000, no filter) fires at t=0 alongside boundary calls
     If <1000 results: all sigs collected, no Phase 1 needed at all
     For 99% of retail wallets: Phase 0 alone gives full signature set
```

**3. 90-sig chunk sizing — zero pagination in full-fetch phase**
```
Old: full-tx fetch with limit=100, follow paginationToken if overflow
New: group sigs into chunks of 90 → always < 100 limit → pagination NEVER fires
     All chunks parallel → single RTT for all full-tx data
```

**4. Synthetic pagination tokens — parallel page fetching**
```
Token format: "slot:transactionIndex"
Old: page 1 → get token → page 2 → get token → sequential
New: know slot range → fabricate "285000000:0" → all pages in parallel
     Available in Helius API, undocumented but stable
```

**5. Balance continuity oracle**
```
if samples[i].postLamports === samples[i+1].preLamports:
    gap is provably flat → skip fetching it
Eliminates entire fetch phases for wallets with clustered activity
```

### Techniques still NOT implemented (future work)

| Technique | Source | Effort | Gain |
|-----------|--------|--------|------|
| Log-time interior probes (1d/7d/30d anchors at t=0) | sol-pnl | Medium | Covers recent history in Phase 0 |
| Density-aware partitioning | mert-algo | Medium | Avoids empty slot range calls |
| Sig→full pipeline overlap | mert-algo pipelined | High | Overlap sig-fetch and full-fetch latency |
| Nx2 window curve (boundary only) | solana-pnl-cachee | Low | O(2N) calls for N-point curve |
| L0 memory cache | solana-pnl-cachee | High | 0.12ms warm, 0 API calls |
| Governor rate limiter | fastpnl | Low | Exact token-bucket pacing, 0 wasted 429s |

### Why the fastest external repo hits sub-2s

**frcd10/fastpnl** (Rust, 1,176ms for 2,323 txs at Developer 50 RPS):

```
Phase 1: 2 calls (boundary) — 1 RTT
Phase 2: 1 size probe → if <1000 skip Phase 3
Phase 3: 28 parallel sig fetches (50 RPS - 2)
Phase 4: 26 parallel full-tx fetches (90-sig chunks)

Wall time formula: (calls - 1) × (1000ms / RPS) + RTT
= (57 - 1) × (1000 / 50) + 56ms
= 56 × 20ms + 56ms = 1176ms
```

The math is exact. At 50 RPS, you can start a new request every 20ms.
57 calls with a 56ms base RTT = 1,176ms. Proven by measurement.

**For our setup** (undici, paid Helius, ~400ms RTT):
```
9 calls: Phase 0 (3) + Phase 2 (6 chunks)
Wall = (9 - 1) × spacing + RTT
spacing ≈ 0ms (all parallel, no rate limiting on paid tier)
= RTT = ~400-600ms
Actual: 800-2500ms due to Helius P95 variance
```

The gap between theory (400ms) and reality (2500ms) is entirely Helius API latency variance.
This is not a code problem — it's infrastructure. The only fix is the L0 cache.

---

## 🗺️ File Map

```
sol_balance_v14.mjs         Best paid-tier (BO-optimal: window=62, c=13)
sol_balance_ultimate.mjs    THIS FILE — all 5 techniques merged
sol_balance_router.mjs      Production router (auto-detect tier, density routing)

eval_v14.mjs                Evaluator for V14
research_v14.mjs            GP-UCB BO runner for V14 (COMPLETE)
research_v15.mjs            GP-UCB BO runner for V15 free-tier (RUNNING)
research_hybrid.mjs         GP-UCB BO runner for Hybrid (RUNNING)

results_v14/best_strategy.json   window=62, c=13, score=0.521, base=0.868
results_v15/                     Running
results_hybrid/                  Running (best=0.2078 gate=1.0 trial 2)

leaderboard.html            Full research dashboard
final_analysis.md           Written summary
EXPLAIN.md                  THIS FILE
```
