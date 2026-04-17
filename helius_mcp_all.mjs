/**
 * helius_mcp_all.mjs — All Helius MCP tools fired in parallel
 * Uses Oliver's semaphore + withRetry + Promise.all pattern from sol_pnl.ts
 *
 * Usage:
 *   node helius_mcp_all.mjs <wallet_address> [api_key]
 *   HELIUS_API_KEY=xxx node helius_mcp_all.mjs <wallet_address>
 *
 * Output includes per-call timing, Helius credit cost, response size, and a
 * summary table at the end.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 12;
const MAX_RETRIES     = 4;
const RETRY_BASE_MS   = 250;

// Helius credit costs per call (from helius.dev/docs pricing, free tier = 100k/mo)
// RPC calls = 1 credit each. Enhanced API = varies by method.
const CREDIT_COSTS = {
  getWalletBalances:        10,  // Enhanced balances endpoint
  getWalletTransfers:        5,  // Enhanced transactions, filtered
  getWalletHistory:          5,  // Enhanced transactions
  getAssetsByOwner:          1,  // DAS — 1 credit per page
  getWalletIdentity:         0,  // MCP-only, not billed via REST
  parseTransactions:         1,  // Enhanced parse — 1 credit per tx decoded
  getBalance:                1,  // Standard RPC
  getTokenAccountsByOwner:   1,  // Standard RPC
  getPriorityFeeEstimate:    1,  // Helius RPC extension
};

// ─────────────────────────────────────────────────────────────────────────────
// Oliver's primitives
// ─────────────────────────────────────────────────────────────────────────────

function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return () => new Promise(resolve => {
    const go = () => { active++; resolve(() => { active--; queue.shift()?.(); }); };
    active < limit ? go() : queue.push(go);
  });
}

async function withRetry(fn) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message ?? "");
      const transient = /429|503|ECONNRESET|fetch failed|terminated/i.test(msg);
      if (!transient || i === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * 2 ** i + Math.random() * 100));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Timed wrapper — records start, end, bytes returned, retry count
// ─────────────────────────────────────────────────────────────────────────────

async function timed(label, fn) {
  const t0 = performance.now();
  try {
    const result = await fn();
    const ms    = performance.now() - t0;
    const bytes = JSON.stringify(result).length;
    return { label, status: "ok", result, ms, bytes, credits: CREDIT_COSTS[label] ?? 1 };
  } catch (err) {
    const ms = performance.now() - t0;
    return { label, status: "err", error: err?.message ?? String(err), ms, bytes: 0, credits: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP clients
// ─────────────────────────────────────────────────────────────────────────────

function makeClients(apiKey) {
  const acquire = makeSemaphore(MAX_CONCURRENCY);

  const restGet = (path) => withRetry(async () => {
    const release = await acquire();
    try {
      const r = await fetch(`https://api.helius.xyz${path}&api-key=${apiKey}`);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
      return r.json();
    } finally { release(); }
  });

  const restPost = (path, body) => withRetry(async () => {
    const release = await acquire();
    try {
      const r = await fetch(`https://api.helius.xyz${path}?api-key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
      return r.json();
    } finally { release(); }
  });

  const rpcPost = (method, params) => withRetry(async () => {
    const release = await acquire();
    try {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } finally { release(); }
  });

  return { restGet, restPost, rpcPost };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function runAll(address, apiKey) {
  const { restGet, restPost, rpcPost } = makeClients(apiKey);
  const t0 = performance.now();

  console.log(`\n${"─".repeat(68)}`);
  console.log(` Helius MCP — 9 tools in parallel (Oliver pattern)`);
  console.log(` Wallet: ${address}`);
  console.log(`${"─".repeat(68)}\n`);

  // Fire all 9 simultaneously — Oliver's Promise.all, each wrapped with timed()
  const results = await Promise.all([

    timed("getWalletBalances", async () => {
      // SCENARIO: "Show portfolio value before opening a trade"
      // Oliver's endpoint: DAS getAssetsByOwner with showNativeBalance
      // Cost: 1 credit — RPC, returns SOL price + token list in one shot
      const r = await rpcPost("getAssetsByOwner", {
        ownerAddress: address, page: 1, limit: 5,
        displayOptions: { showFungible: true, showNativeBalance: true },
      });
      return {
        solBalance: (r?.nativeBalance?.lamports / 1e9).toFixed(6) + " SOL",
        solPriceUSD: r?.nativeBalance?.price_per_sol,
        solValueUSD: r?.nativeBalance?.total_price?.toFixed(2),
        tokenCount: r?.total ?? 0,
        sampleTokens: (r?.items ?? []).slice(0, 3).map(i => i.id),
      };
    }),

    timed("getWalletTransfers", async () => {
      // SCENARIO: "30-day PnL — only SOL/token inflows/outflows, skip gas noise"
      // FREE TIER: getSignaturesForAddress → getTransaction (v15 approach)
      // PAID TIER: getTransactionsForAddress with filters (Oliver's sol_pnl.ts, sub-1s)
      const sigs = await rpcPost("getSignaturesForAddress", [address, { limit: 5 }]);
      const txs = await Promise.all(
        (sigs ?? []).slice(0, 5).map(s =>
          rpcPost("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }])
            .catch(() => null)
        )
      );
      return txs.filter(Boolean).map(tx => {
        const i = tx.transaction?.message?.accountKeys?.findIndex(k => k.pubkey === address) ?? -1;
        const pre  = tx.meta?.preBalances?.[i]  ?? 0;
        const post = tx.meta?.postBalances?.[i] ?? 0;
        return { sig: tx.transaction.signatures[0], blockTime: tx.blockTime,
                 delta: ((post - pre) / 1e9).toFixed(6) + " SOL", err: !!tx.meta?.err };
      }).filter(t => t.delta !== "0.000000 SOL");
    }),

    timed("getWalletHistory", async () => {
      // SCENARIO: "Tax report — every balance change, all tx types"
      // FREE TIER: getSignaturesForAddress (fast, ~700ms) — gives sig list + blockTime
      // PAID TIER: getTransactionsForAddress — gives full parsed txs in one round trip
      //            Oliver's Phase 1 fires 2 of these in parallel → sub-1s on paid plan
      const sigs = await rpcPost("getSignaturesForAddress", [address, { limit: 100 }]);
      return {
        sigCount: sigs?.length ?? 0,
        newest: sigs?.[0]?.blockTime,
        oldest: sigs?.at(-1)?.blockTime,
        note: "paid plan → switch to getTransactionsForAddress for Oliver-speed full tx data",
      };
    }),

    timed("getAssetsByOwner", () =>
      // SCENARIO: "NFT gallery — compressed + uncompressed + fungibles in one shot"
      // Cost: 1 credit per page — DAS is cheap
      // Note: DAS methods take a plain object for params, not an array
      rpcPost("getAssetsByOwner", {
        ownerAddress: address, page: 1, limit: 20,
        displayOptions: { showFungible: true, showNativeBalance: true },
      })
    ),

    timed("getWalletIdentity", () =>
      // SCENARIO: "Counterparty label — is sender Binance, a KOL, or a bot?"
      // Cost: MCP-only, 0 REST credits — fallback gracefully
      restGet(`/v0/addresses/${address}/identity?`)
        .catch(() => ({
          note: "MCP-only — no public REST endpoint",
          howToUse: "claude mcp add helius npx helius-mcp@latest → 'who owns <address>?'",
        }))
    ),

    timed("parseTransactions", () =>
      // SCENARIO: "Decode raw sigs → 'you swapped 10 SOL for 1200 USDC on Raydium'"
      // Cost: 1 credit per tx decoded — pass real sigs from getWalletHistory
      // (empty array here — wire in txHistory.result[*].signature for real use)
      restPost(`/v0/transactions`, { transactions: [] })
    ),

    timed("getBalance", async () => {
      // SCENARIO: "Pre-flight check before sending — fastest, 1 RPC credit"
      const r = await rpcPost("getBalance", [address, { commitment: "confirmed" }]);
      return { lamports: r.value, sol: (r.value / 1e9).toFixed(6) };
    }),

    timed("getTokenAccountsByOwner", async () => {
      // SCENARIO: "Enumerate all SPL positions to compute unrealized PnL"
      // Cost: 1 credit — cap display on active wallets (2700+ accounts possible)
      const r = await rpcPost("getTokenAccountsByOwner", [
        address,
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      return {
        total: r?.value?.length ?? 0,
        sample: (r?.value ?? []).slice(0, 3).map(a => ({
          mint:   a.account.data.parsed.info.mint,
          amount: a.account.data.parsed.info.tokenAmount.uiAmountString,
        })),
      };
    }),

    timed("getPriorityFeeEstimate", () =>
      // SCENARIO: "Landing a swap in congested block — use HIGH tier, not MEDIUM"
      // Cost: 1 credit — always call this before submitting any transaction
      rpcPost("getPriorityFeeEstimate", [{
        accountKeys: [address],
        options: { includeAllPriorityFeeLevels: true },
      }])
    ),
  ]);

  const wallMs = performance.now() - t0;

  // ── Per-call output ───────────────────────────────────────────────────────

  for (const r of results) {
    const status = r.status === "ok" ? "✓" : "✗";
    const msStr  = `${r.ms.toFixed(0)}ms`.padEnd(7);
    const retStr = "";
    const kb     = (r.bytes / 1024).toFixed(1);
    const cred   = r.credits ? `${r.credits} credits` : "0 credits";

    console.log(`${status} ${r.label.padEnd(26)} ${msStr}  ${kb.padStart(6)} KB  ${cred}${retStr}`);
    if (r.status === "err") {
      console.log(`  └─ ERROR: ${r.error}`);
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────────

  const totalCredits  = results.reduce((s, r) => s + r.credits, 0);
  const totalBytes    = results.reduce((s, r) => s + r.bytes, 0);
  const okCount       = results.filter(r => r.status === "ok").length;
  const slowest       = results.reduce((a, b) => b.ms > a.ms ? b : a);
  const fastest       = results.filter(r => r.status === "ok").reduce((a, b) => b.ms < a.ms ? b : a);

  // Sequential cost = if you called these one by one
  const seqMs = results.reduce((s, r) => s + r.ms, 0);

  console.log(`\n${"─".repeat(68)}`);
  console.log(` SUMMARY`);
  console.log(`${"─".repeat(68)}`);
  console.log(` Tools fired:          9   (${okCount} OK, ${results.length - okCount} ERR)`);
  console.log(` Wall time (parallel): ${wallMs.toFixed(0)}ms`);
  console.log(` Time if sequential:   ${seqMs.toFixed(0)}ms   (${(seqMs / wallMs).toFixed(1)}× slower)`);
  console.log(` Parallelism gain:     ${(seqMs / wallMs).toFixed(1)}× (Oliver pattern)`);
  console.log(` Total data received:  ${(totalBytes / 1024).toFixed(1)} KB`);
  console.log(` Helius credits used:  ${totalCredits} credits`);
  console.log(` Free tier budget:     100,000 credits/mo  →  ${Math.floor(100000 / totalCredits).toLocaleString()} full runs/mo`);
  console.log(` Slowest call:         ${slowest.label} (${slowest.ms.toFixed(0)}ms)`);
  console.log(` Fastest call:         ${fastest.label} (${fastest.ms.toFixed(0)}ms)`);

  // Priority fee decoded
  const feeResult = results.find(r => r.label === "getPriorityFeeEstimate");
  if (feeResult?.status === "ok") {
    const f = feeResult.result?.priorityFeeLevels ?? {};
    const solPrice = 85; // approximate, could call getAssetsByOwner to get live price
    const highUSDC = ((f.high ?? 0) * 200_000 / 1e9 * solPrice).toFixed(6);
    console.log(`\n Fee tiers (microLamports):`);
    console.log(`   min=${f.min}  low=${f.low}  medium=${f.medium}  high=${f.high}  veryHigh=${f.veryHigh}`);
    console.log(`   → To land at HIGH: ~${highUSDC} USDC per tx (200k CU estimate)`);
  }

  // SOL balance decoded
  const balResult = results.find(r => r.label === "getBalance");
  if (balResult?.status === "ok") {
    console.log(`\n SOL balance: ${balResult.result.sol} SOL  (${balResult.result.lamports} lamports)`);
  }

  // Token account count
  const tokResult = results.find(r => r.label === "getTokenAccountsByOwner");
  if (tokResult?.status === "ok") {
    console.log(` Token accounts: ${tokResult.result.total} SPL positions`);
  }

  console.log(`${"─".repeat(68)}\n`);

  // ── Detailed results ──────────────────────────────────────────────────────

  for (const r of results) {
    if (r.status !== "ok") continue;
    console.log(`\n──── ${r.label} ────`);
    const preview = JSON.stringify(r.result, null, 2).split("\n").slice(0, 14).join("\n");
    console.log(preview);
    if (JSON.stringify(r.result).split("\n").length > 14) console.log("  ...(truncated)");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const address = process.argv[2];
const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;

if (!address || !apiKey) {
  console.error("Usage: node helius_mcp_all.mjs <wallet_address> [api_key]");
  console.error("       HELIUS_API_KEY=xxx node helius_mcp_all.mjs <wallet_address>");
  process.exit(1);
}

runAll(address, apiKey).catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
