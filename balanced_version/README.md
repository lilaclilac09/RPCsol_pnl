# SOL BALANCE ROUTER V2 · DEVELOPER PLAN · HELIUS

**Fastest SOL Balance History on Mainnet**

Single file. No framework. Developer plan (Helius) + undici HTTP/1.1 connection pool. Returns every SOL balance change for any wallet — sparse or dense — all under 2s.

**[sol_balance_router.mjs](sol_balance_router.mjs)**

---

## Measured Results

Warm measurements — Developer plan (Helius), undici pool pre-warmed. All gate=1.0 (under 2s).

| Wallet | Txs | Time | Calls | Phase | Gate | Score |
|--------|-----|------|-------|-------|------|-------|
| SPARSE — `54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs` | 4 | **0.65s** | 4 | Phase 0 only | 1.0 | 1.538 |
| MEDIUM — `54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs` | 60 | **1.35s** | 4 | Phase 0 only | 1.0 | 0.741 |
| DENSE — `59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n` | 451 | **1.68s** | 8 | Phase 0+2 | 1.0 | 0.595 |
| LARGE *(projected)* | ~50k | ~4.6s | 622 | Phase 0+1+2 | 0.60 | — |
| MEGA *(projected)* | ~1M | ~78s | 12,362 | needs L0 cache | 0.05 | — |

Score = `(1000 / avgMs) × gate`. Gate: <2s = 1.0, <3s = 0.60, ≥3s = 0.05.
Cold start adds ~0.3s — call `warmup(apiKey)` once at startup.

---

## Wallet Classification

The router classifies wallets at Phase 0 based on sig probe count, then routes to the cheapest path.

| Label | Tx count | Phases used | Calls (approx) | Wall time |
|-------|----------|-------------|----------------|-----------|
| sparse | ≤100 txs | Phase 0 only | 3 + ceil(N/90) | 0.5–1.0s |
| medium | 101–999 txs | Phase 0 only | 3 + ceil(N/90) | 1.0–1.8s |
| dense | 1k–10k txs | Phase 0 + 1 + 2 | 3 + bands + ceil(N/90) | 1.5–2.5s |
| whale | >10k txs | Phase 0 + 1 + 2 | 3 + many bands + ceil(N/90) | 3s+ |

---

## How It Works — 5 Techniques

**1. HTTP/1.1 connection pool — 64 persistent sockets (undici)**

HTTP/2 on Helius/Cloudflare is 6× slower. Cloudflare's HTTP/2 scheduler serialises parallel requests server-side, so your 16 "parallel" requests get handled one by one. undici with 64 HTTP/1.1 sockets bypasses this — each request gets its own socket. True parallelism. Measured 6× faster than HTTP/2 on Helius.

**2. Phase 0 fan-out — 3 parallel calls at t=0**

Fire three calls simultaneously the moment the function starts: first-tx boundary (asc, limit=1), last-tx boundary (desc, limit=1), sig probe (asc, limit=1000). For 99% of retail wallets (≤1000 txs), the sig probe returns all signatures — Phase 1 is skipped entirely. All data collected in a single RTT (~400ms).

**3. 90-sig chunks — pagination never fires**

Helius enforces a 100-transaction limit per `getTransactionsForAddress` call. At exactly 100, the API sometimes returns a `paginationToken` that forces a sequential follow-up. Chunks of 90 never trigger pagination. All chunks fire in parallel — single RTT for all full transaction data regardless of wallet size.

**4. Dynamic band sizing + recursive bisection**

For wallets with >1000 txs, the sig sweep is density-estimated from the Phase 0 probe: if 1000 sigs covered 43% of the slot span, the remaining 57% contains ~1323 more sigs. Band count = `ceil(estTotal / 800)`. If any band overflows (returns exactly 1000 sigs), it is bisected into two parallel halves recursively (max depth 8) — no sequential pagination chains.

**5. Phantom paginationToken fix**

Helius returns a `paginationToken` even when `data.length < limit`. Following this phantom token makes an extra API call that returns empty results. Fix: `if (data.length < SIG_MAX) return`. For a dense wallet (451 txs), this dropped 14 calls → 10 calls, 3.0s → 2.1s (−28%).

---

## Replicate It

Requirements: Node.js 18+, Helius Developer plan API key ([helius.dev](https://helius.dev)).

### Install

```bash
git clone https://github.com/lilaclilac09/RPCsol_pnl
cd RPCsol_pnl/balanced_version
npm install
```

### Run from CLI

```bash
# Any wallet — auto-detects paid vs free tier
node sol_balance_router.mjs <wallet-address> <helius-api-key>

# Force paid tier (Developer plan)
node sol_balance_router.mjs <wallet-address> <helius-api-key> --paid

# Benchmark timing
node sol_balance_router.mjs <wallet-address> <helius-api-key> --bench
```

### Use as a module

```js
import { fetchBalanceHistory, warmup } from "./sol_balance_router.mjs";

// Warm up once at startup — eliminates ~300ms cold-start TLS penalty
await warmup("your-helius-api-key");

const result = await fetchBalanceHistory(
  "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs",
  "your-helius-api-key"
);

console.log(result.points);   // balance events
console.log(result.stats);    // timing + call count
```

### Output

```js
{
  points: [
    { slot: 285000000, lamports: 10500000000, blockTime: 1700000000, kind: "credit" },
    // ...
  ],
  stats: {
    wallTimeMs:    652,
    totalRpcCalls: 4,
    sampleCount:   4,
    apiTier:       "paid",
    walletType:    "sparse"
  },
  routing: {
    tier:       "paid",
    walletType: "sparse",
    mode:       "phase0_only"
  }
}
```

`lamports → SOL`: divide by 1,000,000,000. `kind`: `"credit"` = balance went up, `"debit"` = went down.

Free tier: works without a paid key but is rate-limited (~10 RPS) — dense wallets will take 5–25s.

---

sol_balance_router.mjs — MIT license  
[github.com/lilaclilac09/RPCsol_pnl/tree/main/balanced_version](https://github.com/lilaclilac09/RPCsol_pnl/tree/main/balanced_version)
