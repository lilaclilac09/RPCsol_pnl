/**
 * Quick benchmark: Scout V2 vs V15
 * Run: HELIUS_API_KEY=your-key node bench_scout_v2.mjs
 */

import { solBalanceOverTime } from "./sol_balance_v15.mjs";
import { solBalanceScoutV2 } from "./sol_balance_scout_v2.mjs";

const TEST_WALLETS = [
  {
    address: "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs",
    type: "sparse",
    name: "Sparse (5 txs)",
  },
  {
    address: "54u5q7Wto6vgyhAgh8xN1AxgkuKo2mPFzohSNu8vwsTs",
    type: "medium",
    name: "Medium (50 txs)",
  },
];

async function main() {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.error(
      "❌ Set HELIUS_API_KEY=... before running\nExample: export HELIUS_API_KEY=your-key-here"
    );
    process.exit(1);
  }

  console.log("\n🚀 Scout V2 Performance Benchmark");
  console.log("═".repeat(70));

  const results = [];

  for (const wallet of TEST_WALLETS) {
    console.log(`\n📊 ${wallet.name}`);
    console.log(`   Address: ${wallet.address.slice(0, 20)}...`);
    console.log("".padEnd(70, "─"));

    // V15 (old)
    let v15Time, v15Calls, v15Samples;
    try {
      console.log("   V15 (old)...");
      const t0 = performance.now();
      const r = await solBalanceOverTime(wallet.address, apiKey, {
        maxConcurrency: 12,
        txTarget: 20,
      });
      v15Time = performance.now() - t0;
      v15Calls = r.stats.totalRpcCalls;
      v15Samples = r.stats.sampleCount;
      console.log(
        `     ✅ ${v15Time.toFixed(0)}ms | ${v15Calls} RPC calls | ${v15Samples} samples`
      );
    } catch (e) {
      console.log(`     ❌ ${e.message}`);
      v15Time = null;
    }

    // Scout V2 (new)
    let scoutTime, scoutCalls, scoutSamples;
    try {
      console.log("   Scout V2 (new)...");
      const t0 = performance.now();
      const r = await solBalanceScoutV2(wallet.address, apiKey, {
        maxConcurrency: 50,
      });
      scoutTime = performance.now() - t0;
      scoutCalls = r.stats.totalRpcCalls;
      scoutSamples = r.stats.sampleCount;
      console.log(
        `     ✅ ${scoutTime.toFixed(0)}ms | ${scoutCalls} RPC calls | ${scoutSamples} samples`
      );
    } catch (e) {
      console.log(`     ❌ ${e.message}`);
      scoutTime = null;
    }

    // Compare
    if (v15Time && scoutTime) {
      const speedup = v15Time / scoutTime;
      const improvement = ((v15Time - scoutTime) / v15Time) * 100;
      console.log("");
      console.log(
        `   ⚡ Speedup: ${speedup.toFixed(1)}x | Time saved: ${improvement.toFixed(0)}%`
      );
      results.push({
        name: wallet.name,
        v15Time,
        scoutTime,
        speedup,
        improvement,
        v15Calls,
        scoutCalls,
      });
    }

    // Wait between calls
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Summary
  if (results.length > 0) {
    console.log("\n" + "═".repeat(70));
    console.log("📈 Summary");
    console.log("═".repeat(70));
    console.log(
      "Wallet".padEnd(20) +
        "V15".padStart(10) +
        "Scout".padStart(10) +
        "Speedup".padStart(10) +
        "Saved".padStart(10)
    );
    console.log("".padEnd(70, "─"));

    for (const r of results) {
      console.log(
        r.name.slice(0, 19).padEnd(20) +
          r.v15Time.toFixed(0).padStart(10) +
          r.scoutTime.toFixed(0).padStart(10) +
          r.speedup.toFixed(1).padStart(10) +
          `${r.improvement.toFixed(0)}%`.padStart(10)
      );
    }

    const avgSpeedup = (
      results.reduce((s, r) => s + r.speedup, 0) / results.length
    ).toFixed(1);
    console.log("".padEnd(70, "─"));
    console.log(
      "AVERAGE".padEnd(20) +
        "".padStart(10) +
        "".padStart(10) +
        avgSpeedup.padStart(10) +
        "".padStart(10)
    );

    console.log("\n✅ Scout V2 Result:");
    if (avgSpeedup >= 2) {
      console.log(
        `   🎯 ${avgSpeedup}x speedup achieved! Ready for integration.`
      );
    } else {
      console.log(
        `   ⚠️  ${avgSpeedup}x speedup (less than 2x target). Check algorithm.`
      );
    }
  }
}

main().catch(console.error);
