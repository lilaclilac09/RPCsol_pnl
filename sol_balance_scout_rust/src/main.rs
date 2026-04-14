// sol_balance_scout_rust/src/main.rs
mod algorithm;
mod rpc;
mod types;

use anyhow::{anyhow, Result};
use serde_json::json;
use std::env;
use std::time::Instant;

use algorithm::{dedup_by_signature, phase0, phase1, phase2, extract_balance_point};
use rpc::RpcClient;
use types::{FullTransaction, SolBalance, Strategy};

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage: {} <ADDRESS> [API_KEY]", args[0]);
        eprintln!("Environment: HELIUS_API_KEY");
        std::process::exit(1);
    }

    let address = &args[1];
    let api_key = args
        .get(2)
        .cloned()
        .or_else(|| env::var("HELIUS_API_KEY").ok())
        .ok_or_else(|| anyhow!("HELIUS_API_KEY not provided"))?;

    let strategy = Strategy::default();

    println!("🚀 Scout Algorithm (Rust) — Fetching {}", address);
    println!("{}", "=".repeat(80));

    let start = Instant::now();

    // Phase 0: Scout both ends
    println!("\n📊 Phase 0: Scout both ends...");
    let (oldest_sigs, newest_sigs) = phase0(&RpcClient::new(&api_key, strategy.max_concurrency), address, &strategy)
        .await?;

    println!(
        "   Oldest: {} sigs | Newest: {} sigs",
        oldest_sigs.len(),
        newest_sigs.len()
    );

    // Phase 1: Scout gap (if needed)
    let rpc = RpcClient::new(&api_key, strategy.max_concurrency);
    let phase1_start = Instant::now();

    println!("\n📊 Phase 1: Scout gap...");
    let scouted_sigs = phase1(&rpc, address, &oldest_sigs, &newest_sigs, &strategy).await?;
    let phase1_ms = phase1_start.elapsed().as_millis();

    println!("   Discovered: {} sigs | Time: {}ms", scouted_sigs.len(), phase1_ms);

    // Combine all signatures
    let mut all_sigs_map = std::collections::HashMap::new();

    for sig in oldest_sigs.iter().chain(newest_sigs.iter()).chain(scouted_sigs.iter()) {
        if !all_sigs_map.contains_key(&sig.signature) {
            all_sigs_map.insert(sig.signature.clone(), sig.clone());
        }
    }

    let all_sigs: Vec<_> = all_sigs_map.into_values().collect();
    println!("\n📊 Total signatures discovered: {}", all_sigs.len());

    // Phase 2: Stream full-transaction fetches
    println!("\n📊 Phase 2: Fetch full transactions...");
    let phase2_start = Instant::now();

    let txs = phase2(&rpc, address, &all_sigs, &strategy).await?;
    let phase2_ms = phase2_start.elapsed().as_millis();

    println!(
        "   Fetched: {} transactions | Time: {}ms",
        txs.len(),
        phase2_ms
    );

    // Extract balance points
    let mut points: Vec<_> = txs
        .iter()
        .filter_map(|tx| {
            extract_balance_point(tx, address).map(|(block_time, slot, sig, balance, delta)| {
                (block_time, slot, sig, balance, delta)
            })
        })
        .collect();

    // Dedup and sort
    points = dedup_by_signature(points);

    let wall_time_ms = start.elapsed().as_millis();

    // Output results
    println!("\n{}", "=".repeat(80));
    println!("SOL Balance History — {}", address);
    println!("{}", "-".repeat(80));
    println!(
        "{}  {}  {}",
        "BlockTime".to_string().as_str(),
        "Balance (SOL)".to_string().as_str(),
        "Delta (SOL)".to_string().as_str()
    );
    println!("{}", "-".repeat(80));

    let opening = if let Some((_, _, _, balance, _)) = points.first() {
        *balance
    } else {
        0
    };

    let closing = if let Some((_, _, _, balance, _)) = points.last() {
        *balance
    } else {
        0
    };

    // Show last 20 transactions
    for (block_time, _slot, sig, balance, delta) in points.iter().rev().take(20) {
        let date = chrono::DateTime::<chrono::Utc>::from_timestamp(*block_time as i64, 0)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(|_| format!("{}s", block_time));

        let balance_sol = *balance as f64 / LAMPORTS_PER_SOL as f64;
        let delta_sol = *delta as i64 as f64 / LAMPORTS_PER_SOL as f64;
        let sign = if delta_sol >= 0.0 { "+" } else { "" };

        println!(
            "{}  {:16.6}  {}{}",
            date,
            balance_sol,
            sign,
            format!("{:.6}", delta_sol)
        );
    }

    println!("{}", "-".repeat(80));
    println!(
        "Opening: {:.6} SOL  →  Closing: {:.6} SOL",
        opening as f64 / LAMPORTS_PER_SOL as f64,
        closing as f64 / LAMPORTS_PER_SOL as f64
    );
    println!("Transactions:    {}", points.len());
    println!("Total RPC calls: {}", rpc.call_count());
    println!("Wall time:       {}ms", wall_time_ms);

    // JSON output for integration
    let json_out = json!({
        "address": address,
        "points": points.len(),
        "opening_balance_lamports": opening,
        "closing_balance_lamports": closing,
        "stats": {
            "totalRpcCalls": rpc.call_count(),
            "phase0Calls": 2,
            "phase1Calls": if scouted_sigs.is_empty() { 0 } else { 1 },
            "phase2Calls": (all_sigs.len() + strategy.phase2_chunk_size - 1) / strategy.phase2_chunk_size,
            "wallTimeMs": wall_time_ms as u128,
            "sampleCount": points.len(),
        }
    });

    println!("\n{}", serde_json::to_string_pretty(&json_out)?);

    Ok(())
}

// For importing as library
pub use algorithm::{dedup_by_signature, phase0, phase1, phase2};
pub use rpc::RpcClient;
pub use types::{SolBalance, Strategy};
