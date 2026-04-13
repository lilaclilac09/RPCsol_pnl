# SOL Balance Router v2

Universal SOL balance history router — single file, no framework.

---

## Measured results

> Developer plan (Helius), undici HTTP/1.1 pool, warm connections.

| Wallet | Txs | Time | Calls | Gate |
|--------|-----|------|-------|------|
| 54uJifihf…fmTs | 4 | **0.65s** | 4 | 1.0 ✓ |
| 54u5q7Wt…wsTs | 60 | **1.35s** | 4 | 1.0 ✓ |
| 59tGCiHi…1P8n | 451 | **1.68s** | 8 | 1.0 ✓ |

All under 2s. Gate=1.0. Score = `1000 / ms × gate`.

---

## Developer plan constraint

These results require a **Helius Developer plan** key (`getTransactionsForAddress` endpoint).

With free-tier keys, any wallet >1000 txs hits HTTP 429 rate limits during the parallel band sweep. The router fires up to 64 concurrent requests — free keys cannot sustain that throughput.

**Free tier still works for sparse/medium wallets (<1000 txs).** Dense and above will fail or be slow.

---

## Projected results *(not measured — rate limited)*

Calculated from wall-time formula: `Wall ≈ (ceil(bands/64) + ceil(chunks/64) + 1) × 400ms RTT`

| Wallet size | Txs | Calls | Projected time | Bottleneck |
|-------------|-----|-------|----------------|------------|
| Whale | ~2,300 | ~29 | ~1.2s | Phase 2 full-tx fetch |
| Large | ~50,000 | ~622 | ~4.6s | 9 RTTs of full-tx fetch |
| Mega | ~1,000,000 | ~12,362 | ~78s | needs L0 in-memory cache |

These projections hold on a true Developer plan with no rate limits. With free keys, they 429.

**Future path**: multi-key parallel distribution — split bands and chunks across N API keys like distributing compute across GPUs. See `MULTIKEY_PLAN.md`.

---

## How it works

### 3 phases

**Phase 0** — 3 calls fire in parallel at t=0:
- First tx boundary (asc, limit=1)
- Last tx boundary (desc, limit=1)  
- Sig probe (asc, limit=1000)

For ≤1000 tx wallets the probe returns everything — Phase 1 skipped. Done in 1 RTT.

**Phase 1** — only for >1000 tx wallets. Estimates band count from probe density, sweeps all bands in parallel. Overflowing bands bisect recursively — no sequential pagination.

**Phase 2** — full-tx fetch in chunks of 90. At 90 Helius never paginates. All chunks fire simultaneously — single RTT.

### 5 techniques

1. **undici HTTP/1.1 (64 sockets)** — HTTP/2 on Helius/Cloudflare serialises requests server-side. HTTP/1.1 pool = true parallelism. 6× faster measured.
2. **Phase 0 3-call fan-out** — no sequential warmup, all data starts flowing at t=0.
3. **90-sig chunks** — 100 triggers pagination, 90 never does. All chunks in 1 RTT.
4. **Dynamic bands + recursive bisection** — band count density-estimated, overflow bands split in parallel not chained sequentially.
5. **Phantom paginationToken fix** — Helius returns a token even when `data.length < limit`. Skip it. Dropped dense wallet 14→8 calls.

---

## Install

```bash
npm install   # installs undici only
```

Node.js 18+ required.

## Usage

```js
import { fetchBalanceHistory, warmup } from "./sol_balance_router.mjs";

await warmup("your-helius-api-key"); // once at startup — eliminates ~300ms cold-start

const result = await fetchBalanceHistory(
  "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n",
  "your-helius-api-key"
);

// result.points  → [{ slot, lamports, blockTime, kind }]
// result.stats   → { wallTimeMs, totalRpcCalls, sampleCount, apiTier, walletType }
```

## CLI

```bash
node sol_balance_router.mjs <address> <api-key> --paid --bench
```

## Files

| File | Purpose |
|------|---------|
| `sol_balance_router.mjs` | The router — import this |
| `package.json` | Dependencies (undici only) |
| `README.md` | This file |
| `MULTIKEY_PLAN.md` | Plan for multi-key distributed fetching |
| `test_multikey.mjs` | Prototype multi-key implementation |
