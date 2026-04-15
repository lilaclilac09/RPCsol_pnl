/**
 * Scenario 4: Daily PnL Bucketing
 *
 * Takes the balance curve from sol_balance.mjs and bins it into daily
 * buckets — opening balance, closing balance, and net PnL per day.
 *
 * Usage: node scenario_pnl_daily.mjs <address> [api-key]
 */

import { solBalanceOverTime } from "./sol_balance.mjs";

const LAMPORTS = 1_000_000_000;

// ── Slot → timestamp calibration via getBlockTime ────────────────────────────
// Picks N evenly-spaced anchor slots from the curve, fetches their real
// block times in parallel, then piecewise-linear interpolates for all others.
// Falls back to the fixed-rate approximation if getBlockTime fails.

async function fetchBlockTimes(slots, apiKey) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const results = await Promise.all(slots.map((slot, i) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "getBlockTime", params: [slot] }),
    })
    .then(r => r.json())
    .then(j => ({ slot, unix: j.result ?? null }))
    .catch(() => ({ slot, unix: null }))
  ));
  return results.filter(r => r.unix !== null);
}

function buildInterpolator(anchors) {
  // anchors: [{slot, unix}, ...] sorted by slot
  const sorted = [...anchors].sort((a, b) => a.slot - b.slot);

  // Fallback if calibration failed entirely
  const GENESIS_UNIX  = 1584368400;
  const SLOTS_PER_SEC = 2.5;
  if (sorted.length === 0) return slot => GENESIS_UNIX + slot / SLOTS_PER_SEC;

  return function interpolate(slot) {
    if (slot <= sorted[0].slot) {
      // Extrapolate left using first two anchors (or first anchor alone)
      const rate = sorted.length > 1
        ? (sorted[1].unix - sorted[0].unix) / (sorted[1].slot - sorted[0].slot)
        : 1 / 2.5;
      return sorted[0].unix + (slot - sorted[0].slot) * rate;
    }
    if (slot >= sorted.at(-1).slot) {
      // Extrapolate right using last two anchors
      const n = sorted.length;
      const rate = n > 1
        ? (sorted[n-1].unix - sorted[n-2].unix) / (sorted[n-1].slot - sorted[n-2].slot)
        : 1 / 2.5;
      return sorted.at(-1).unix + (slot - sorted.at(-1).slot) * rate;
    }
    // Piecewise linear between the two surrounding anchors
    let lo = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (slot >= sorted[i].slot && slot <= sorted[i+1].slot) { lo = i; break; }
    }
    const a = sorted[lo], b = sorted[lo + 1];
    const t = (slot - a.slot) / (b.slot - a.slot);
    return a.unix + t * (b.unix - a.unix);
  };
}

async function calibrateSlotToDate(points, apiKey, numAnchors = 5) {
  if (points.length === 0) return slot => new Date(0).toISOString().slice(0, 10);

  const slots = points.map(p => p.slot).sort((a, b) => a - b);
  // Pick evenly spaced indices across the unique slot range
  const step = Math.max(1, Math.floor((slots.length - 1) / (numAnchors - 1)));
  const anchorSlots = [...new Set(
    Array.from({ length: numAnchors }, (_, i) => slots[Math.min(i * step, slots.length - 1)])
  )];

  process.stderr.write(`Calibrating slot→date with ${anchorSlots.length} getBlockTime calls… `);
  const anchors = await fetchBlockTimes(anchorSlots, apiKey);
  process.stderr.write(`got ${anchors.length} anchors\n`);

  const interpolate = buildInterpolator(anchors);
  return slot => new Date(interpolate(slot) * 1000).toISOString().slice(0, 10);
}

function bucketByDay(points, slotToDate) {
  const days = {};
  for (const p of points) {
    const day = slotToDate(p.slot);
    if (!days[day]) days[day] = { open: p.lamports, close: p.lamports };
    days[day].close = p.lamports;
  }
  return days;
}

const address = process.argv[2];
const apiKey  = process.argv[3] ?? process.env.HELIUS_API_KEY;

if (!address || !apiKey) {
  console.error("Usage: node scenario_pnl_daily.mjs <address> [api-key]");
  process.exit(1);
}

console.log(`Daily PnL for ${address} …\n`);
const result = await solBalanceOverTime(address, apiKey);

const slotToDate = await calibrateSlotToDate(result.points, apiKey);
const days = bucketByDay(result.points, slotToDate);
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
console.log(`Total PnL: ${(runningPnl >= 0 ? "+" : "") + runningPnl.toFixed(6)} SOL`);
console.log(`RPC calls: ${result.stats.totalRpcCalls}  |  ${result.stats.wallTimeMs.toFixed(0)}ms`);
