/**
 * Benchmark: Compare V15 (old) vs Scout (new) latency
 *
 * Typical baseline:
 *   V15:     1.0-2.5s per wallet (depends on size)
 *   Scout:   0.3-0.8s per wallet (Oliver's algorithm)
 *   Target:  3-8x speedup
 */

import { solBalanceOverTime } from "./sol_balance_v15.mjs";
import { solBalanceScout } from "./sol_balance_scout.mjs";

const TEST_WALLETS = [
  {
    address: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs",
    type: "sparse",
    expectedTxs: 5,
  },
  {
    address: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs",
    type: "medium",
    expectedTxs: 50,
  },
  {
    address: "59tGCiHiqPZTkA18SpKVxBrwRMsKRdRCS8HeFz9J1P8n",
    type: "dense",
    expectedTxs: 200,
  },
];

async function benchmark() {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.error("Set HELIUS_API_KEY env var");
    process.exit(1);
  }

  console.log("📊 Benchmark: V15 vs Scout Algorithm");
  console.log("".padEnd(80, "="));
  console.log("");

  const results = [];

  for (const wallet of TEST_WALLETS) {
    console.log(`\n🔍 Testing ${wallet.type.toUpperCase()}`);
    console.log(`   Address: ${wallet.address}`);
    console.log("".padEnd(80, "-"));

    // V15 baseline
    let v15Time = null;
    let v15Calls = null;
    let v15Txs = null;
    try {
      console.log("   Running V15 (old)...");
      const t0 = performance.now();
      const v15Result = await solBalanceOverTime(wallet.address, apiKey, {
        maxConcurrency: 12,
        txTarget: 20,
      });
      v15Time = performance.now() - t0;
      v15Calls = v15Result.stats.totalRpcCalls;
      v15Txs = v15Result.stats.sampleCount;
      console.log(
        `   ✅ V15 completed: ${v15Time.toFixed(0)}ms, ${v15Calls} calls, ${v15Txs} samples`
      );
    } catch (e) {
      console.log(`   ❌ V15 failed: ${e.message}`);
    }

    // Scout new algorithm
    let scoutTime = null;
    let scoutCalls = null;
    let scoutTxs = null;
    try {
      console.log("   Running Scout (new)...");
      const t0 = performance.now();
      const scoutResult = await solBalanceScout(wallet.address, apiKey, {
        maxConcurrency: 100,
      });
      scoutTime = performance.now() - t0;
      scoutCalls = scoutResult.stats.totalApiCalls;
      scoutTxs = scoutResult.points.length;
      console.log(
        `   ✅ Scout completed: ${scoutTime.toFixed(0)}ms, ${scoutCalls} calls, ${scoutTxs} txs`
      );
    } catch (e) {
      console.log(`   ❌ Scout failed: ${e.message}`);
    }

    // Compare
    if (v15Time && scoutTime) {
      const speedup = (v15Time / scoutTime).toFixed(1);
      const improvement = ((v15Time - scoutTime) / v15Time * 100).toFixed(0);
      console.log("");
      console.log(`   📈 Speedup: ${speedup}x`);
      console.log(`   ⚡ Time saved: ${improvement}%`);
      results.push({
        wallet: wallet.type,
        v15Time,
        scoutTime,
        v15Calls,
        scoutCalls,
        v15Txs,
        scoutTxs,
        speedup: parseFloat(speedup),
        improvement: parseInt(improvement),
      });
    }

    // Cool down between wallets
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Summary
  console.log("\n" + "".padEnd(80, "="));
  console.log("📊 Summary");
  console.log("".padEnd(80, "="));
  console.log(
    "Type".padEnd(12) +
      "V15 (ms)".padStart(12) +
      "Scout (ms)".padStart(12) +
      "Speedup".padStart(10) +
      "Improvement".padStart(12)
  );
  console.log("".padEnd(80, "-"));

  for (const r of results) {
    console.log(
      r.wallet.padEnd(12) +
        r.v15Time.toFixed(0).padStart(12) +
        r.scoutTime.toFixed(0).padStart(12) +
        r.speedup.toFixed(1).padStart(10) +
        `${r.improvement}%`.padStart(12)
    );
  }

  if (results.length > 0) {
    const avgSpeedup = (
      results.reduce((s, r) => s + r.speedup, 0) / results.length
    ).toFixed(1);
    const avgImprovement = Math.round(
      results.reduce((s, r) => s + r.improvement, 0) / results.length
    );
    console.log("".padEnd(80, "-"));
    console.log(
      "AVERAGE".padEnd(12) +
        "".padStart(12) +
        "".padStart(12) +
        avgSpeedup.padStart(10) +
        `${avgImprovement}%`.padStart(12)
    );
  }

  console.log("");
  console.log("🎯 Next steps:");
  console.log("   1. If Scout is 2-8x faster, integrate into test suite");
  console.log("   2. Tune maxConcurrency based on rate limits");
  console.log("   3. Profile HTTP/2 windows vs. default fetch");
}

benchmark().catch(console.error);
