/**
 * Demo: scenario_pnl_daily.mjs (with getBlockTime calibration)
 *
 * Shows the slot→date calibration step using mocked getBlockTime anchors,
 * then compares naive approximation vs calibrated dates side by side.
 *
 * Run: node demo_pnl_daily.mjs
 */

const LAMPORTS = 1_000_000_000;

// ── Mock balance curve ────────────────────────────────────────────────────────
// Real slots from late 2023. Each day ≈ 216,000 slots at ~2.5 slots/sec.
const DAY  = 216_000;
const BASE = 300_000_000; // ≈ slot value for 2023-11-15 by naive formula

const MOCK_RESULT = {
  address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  points: [
    { slot: BASE + 0,              lamports: 10_000_000_000, kind: "sample" },
    { slot: BASE + 50_000,         lamports: 15_000_000_000, kind: "sample" },
    { slot: BASE + DAY + 10_000,   lamports: 12_000_000_000, kind: "sample" },
    { slot: BASE + DAY + 80_000,   lamports: 12_000_000_000, kind: "flat"   },
    { slot: BASE + DAY*2 + 5_000,  lamports: 20_000_000_000, kind: "sample" },
    { slot: BASE + DAY*2 + 90_000, lamports: 19_000_000_000, kind: "sample" },
    { slot: BASE + DAY*3 + 30_000, lamports: 15_000_000_000, kind: "sample" },
    { slot: BASE + DAY*4 + 20_000, lamports: 17_000_000_000, kind: "sample" },
    { slot: BASE + DAY*4 + 70_000, lamports: 16_000_000_000, kind: "sample" },
    { slot: BASE + DAY*5 + 100_000,lamports: 16_000_000_000, kind: "flat"   },
  ],
  openingLamports: 10_000_000_000,
  closingLamports: 16_000_000_000,
  stats: { totalRpcCalls: 8, wallTimeMs: 1240, resolvedByContinuity: 2, openGapsRemaining: 0, sampleCount: 10 },
};

// ── Naive approximation (old approach) ───────────────────────────────────────
const GENESIS_UNIX  = 1584368400;
const SLOTS_PER_SEC = 2.5;
function naiveSlotToDate(slot) {
  return new Date((GENESIS_UNIX + slot / SLOTS_PER_SEC) * 1000).toISOString().slice(0, 10);
}

// ── Mock getBlockTime anchors ─────────────────────────────────────────────────
// Real Solana mainnet drifts from the naive formula — slots/sec has varied
// over the chain's history (outages, upgrades). These mock values reflect
// what getBlockTime would actually return for these slot numbers.
// Naive formula puts BASE ≈ 2024-01-04; real chain puts it at 2023-11-15.
const MOCK_BLOCK_TIMES = {
  [BASE]:              1699977600, // 2023-11-14 16:00 UTC (real anchor)
  [BASE + DAY*2]:      1700409600, // 2023-11-19 16:00 UTC
  [BASE + DAY*5 + 100_000]: 1700841600, // 2023-11-24 16:00 UTC
};

// ── Calibration (same logic as scenario_pnl_daily.mjs) ───────────────────────
function buildInterpolator(anchors) {
  const sorted = [...anchors].sort((a, b) => a.slot - b.slot);
  if (sorted.length === 0) return slot => GENESIS_UNIX + slot / SLOTS_PER_SEC;

  return function interpolate(slot) {
    if (slot <= sorted[0].slot) {
      const rate = sorted.length > 1
        ? (sorted[1].unix - sorted[0].unix) / (sorted[1].slot - sorted[0].slot)
        : 1 / 2.5;
      return sorted[0].unix + (slot - sorted[0].slot) * rate;
    }
    if (slot >= sorted.at(-1).slot) {
      const n = sorted.length;
      const rate = n > 1
        ? (sorted[n-1].unix - sorted[n-2].unix) / (sorted[n-1].slot - sorted[n-2].slot)
        : 1 / 2.5;
      return sorted.at(-1).unix + (slot - sorted.at(-1).slot) * rate;
    }
    let lo = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (slot >= sorted[i].slot && slot <= sorted[i+1].slot) { lo = i; break; }
    }
    const a = sorted[lo], b = sorted[lo + 1];
    const t = (slot - a.slot) / (b.slot - a.slot);
    return a.unix + t * (b.unix - a.unix);
  };
}

const anchors = Object.entries(MOCK_BLOCK_TIMES).map(([slot, unix]) => ({ slot: +slot, unix }));
const interpolate = buildInterpolator(anchors);
function calibratedSlotToDate(slot) {
  return new Date(interpolate(slot) * 1000).toISOString().slice(0, 10);
}

// ── Bucketing ─────────────────────────────────────────────────────────────────
function bucketByDay(points, slotToDate) {
  const days = {};
  for (const p of points) {
    const day = slotToDate(p.slot);
    if (!days[day]) days[day] = { open: p.lamports, close: p.lamports };
    days[day].close = p.lamports;
  }
  return days;
}

// ── Run ────────────────────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║     DEMO: scenario_pnl_daily.mjs + getBlockTime calib       ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

// Show calibration step
console.log("── Step 1: fetch getBlockTime for 3 anchor slots ───────────────");
for (const { slot, unix } of anchors.sort((a, b) => a.slot - b.slot)) {
  const date = new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ");
  const naive = naiveSlotToDate(slot);
  const delta = Math.round((unix - (GENESIS_UNIX + slot / SLOTS_PER_SEC)) / 86400);
  console.log(`  slot ${slot}  →  real: ${date} UTC  (naive said: ${naive}, off by ${delta > 0 ? "+" : ""}${delta}d)`);
}

console.log("\n── Step 2: piecewise-linear interpolate all other slots ────────");
console.log("  (no extra RPC calls — interpolated from anchors)\n");

// Side-by-side comparison on first few points
console.log("  SLOT           NAIVE DATE    CALIBRATED DATE");
console.log("  " + "─".repeat(48));
for (const p of MOCK_RESULT.points.slice(0, 5)) {
  const naive = naiveSlotToDate(p.slot);
  const cal   = calibratedSlotToDate(p.slot);
  const mark  = naive !== cal ? " ◄ fixed" : "";
  console.log(`  ${String(p.slot).padEnd(14)} ${naive}    ${cal}${mark}`);
}

console.log("\n── Step 3: bucket by calibrated date ───────────────────────────\n");

console.log(`Daily PnL for ${MOCK_RESULT.address}\n`);

const days = bucketByDay(MOCK_RESULT.points, calibratedSlotToDate);
const entries = Object.entries(days).sort(([a], [b]) => a.localeCompare(b));

let runningPnl = 0;
console.log("DATE         OPEN (SOL)       CLOSE (SOL)      DAY PnL         CUMULATIVE");
console.log("─".repeat(80));

for (const [day, { open, close }] of entries) {
  const dayPnl = (close - open) / LAMPORTS;
  runningPnl  += dayPnl;
  const openSol  = (open  / LAMPORTS).toFixed(4).padStart(12);
  const closeSol = (close / LAMPORTS).toFixed(4).padStart(12);
  const pnlStr   = (dayPnl >= 0 ? "+" : "") + dayPnl.toFixed(4);
  const cumStr   = (runningPnl >= 0 ? "+" : "") + runningPnl.toFixed(4);
  console.log(`${day}  ${openSol}     ${closeSol}     ${pnlStr.padStart(10)}     ${cumStr.padStart(10)}`);
}

console.log("─".repeat(80));
const totalPnl = (MOCK_RESULT.closingLamports - MOCK_RESULT.openingLamports) / LAMPORTS;
console.log(`Total PnL: ${(totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(6)} SOL`);
console.log(`Calibration: 3 getBlockTime calls  |  Balance curve: ${MOCK_RESULT.stats.totalRpcCalls} RPC calls`);

console.log("\n── Why this matters ────────────────────────────────────────────");
console.log("• Solana has had outages and validator speed changes since 2020.");
console.log("  The naive 2.5 slots/sec formula can be off by weeks on old slots.");
console.log("• 3–5 getBlockTime calls + interpolation costs almost nothing but");
console.log("  gives accurate dates across the entire history range.");
console.log("• Errors compound for wallets active since 2021–2022 — PnL rows");
console.log("  could land on the wrong day without calibration.");
console.log("\nTo run live: node scenario_pnl_daily.mjs <address> $HELIUS_API_KEY");
