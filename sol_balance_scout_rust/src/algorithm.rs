// sol_balance_scout_rust/src/algorithm.rs
use anyhow::Result;
use futures::future::join_all;
use std::collections::{HashMap, HashSet};

use crate::rpc::RpcClient;
use crate::types::{FullTransaction, SignatureInfo, Strategy};

/// Phase 0: Scout both ends (oldest 1000 + newest 1000 signatures)
/// This establishes density anchors and determines if gap scouting is needed.
pub async fn phase0(
    rpc: &RpcClient,
    address: &str,
    strategy: &Strategy,
) -> Result<(Vec<SignatureInfo>, Vec<SignatureInfo>)> {
    let oldest_fut = rpc.get_signatures(
        address,
        strategy.phase0_sig_limit,
        None,
        strategy.max_retries,
        strategy.retry_base_ms,
    );

    let newest_fut = rpc.get_signatures(
        address,
        strategy.phase0_sig_limit,
        None,
        strategy.max_retries,
        strategy.retry_base_ms,
    );

    let (oldest_result, newest_result) = tokio::try_join!(oldest_fut, newest_fut)?;

    // Filter to succeeded (err === null)
    let oldest_sigs: Vec<_> = oldest_result
        .into_iter()
        .filter(|s| s.err.is_none())
        .collect();

    let newest_sigs: Vec<_> = newest_result
        .into_iter()
        .filter(|s| s.err.is_none())
        .collect();

    Ok((oldest_sigs, newest_sigs))
}

/// Estimate density from anchor points
fn estimate_density(oldest_sigs: &[SignatureInfo], newest_sigs: &[SignatureInfo]) -> f64 {
    if oldest_sigs.is_empty() || newest_sigs.is_empty() {
        return 10.0;
    }

    let oldest_time = oldest_sigs
        .first()
        .and_then(|s| s.block_time)
        .unwrap_or(0) as f64;

    let newest_time = newest_sigs
        .first()
        .and_then(|s| s.block_time)
        .unwrap_or(0) as f64;

    if (oldest_time - newest_time).abs() < 1.0 {
        return 10.0;
    }

    let total_sigs = (oldest_sigs.len() + newest_sigs.len()) as f64;
    let time_span = (oldest_time - newest_time).abs();
    let density = total_sigs / time_span;

    density.max(1.0).min(100.0) // Clamp to reasonable range
}

/// Calculate adaptive number of slices based on density
fn calculate_adaptive_slices(density: f64, target_per_slice: f64) -> usize {
    let estimated_slices = (density / target_per_slice).ceil() as usize;
    estimated_slices.max(4).min(12) // Clamp between 4-12
}

/// Phase 1: Adaptive gap scouting (for busy wallets with >2000 total txs)
pub async fn phase1(
    rpc: &RpcClient,
    address: &str,
    oldest_sigs: &[SignatureInfo],
    newest_sigs: &[SignatureInfo],
    strategy: &Strategy,
) -> Result<Vec<SignatureInfo>> {
    let total_coverage = oldest_sigs.len() + newest_sigs.len();

    // Fast path: sparse wallet, no gap
    if total_coverage < 2000 {
        return Ok(Vec::new());
    }

    // Estimate density and calculate slices
    let density = estimate_density(oldest_sigs, newest_sigs);
    let num_slices = calculate_adaptive_slices(density, strategy.phase1_target_density);

    // Scout slices in parallel using stratified pagination hints
    let scout_futs: Vec<_> = (0..num_slices)
        .map(|i| {
            let hint_idx = (i as f64 * total_coverage as f64 / num_slices as f64) as usize;

            let before_sig = if hint_idx < oldest_sigs.len() {
                Some(oldest_sigs[hint_idx].signature.as_str())
            } else if !newest_sigs.is_empty() {
                let idx = hint_idx - oldest_sigs.len();
                if idx < newest_sigs.len() {
                    Some(newest_sigs[idx].signature.as_str())
                } else {
                    None
                }
            } else {
                None
            };

            rpc.get_signatures(
                address,
                1000,
                before_sig,
                strategy.max_retries,
                strategy.retry_base_ms,
            )
        })
        .collect();

    let results = futures::future::join_all(scout_futs).await;

    // Collect and dedup
    let mut sig_map: HashMap<String, SignatureInfo> = HashMap::new();

    for result in results {
        if let Ok(sigs) = result {
            for sig in sigs {
                if sig.err.is_none() {
                    sig_map.insert(sig.signature.clone(), sig);
                }
            }
        }
    }

    Ok(sig_map.into_values().collect())
}

/// Extract balance point from a full transaction
fn extract_balance_point(
    tx: &FullTransaction,
    address: &str,
) -> Option<(u64, u64, String, u64, u64)> {
    let keys = &tx.transaction.message.account_keys;

    // Find address in account keys
    let idx = keys.iter().position(|k| {
        if let Some(s) = k.as_str() {
            s == address
        } else if let Some(obj) = k.as_object() {
            obj.get("pubkey")
                .and_then(|v| v.as_str())
                .map(|s| s == address)
                .unwrap_or(false)
        } else {
            false
        }
    })?;

    let pre = *tx.meta.pre_balances.get(idx).unwrap_or(&0);
    let post = *tx.meta.post_balances.get(idx).unwrap_or(&0);

    let block_time = tx.block_time.unwrap_or(0);
    let slot = tx.slot;
    let sig = tx.transaction.signatures.get(0)?.clone();

    Some((block_time, slot, sig, post, (post as i64 - pre as i64) as u64))
}

/// Phase 2: Stream full-transaction fetches in parallel chunks
pub async fn phase2(
    rpc: &RpcClient,
    address: &str,
    all_sigs: &[SignatureInfo],
    strategy: &Strategy,
) -> Result<Vec<FullTransaction>> {
    let mut txs = Vec::new();

    // Chunk signatures
    let chunks: Vec<_> = all_sigs
        .chunks(strategy.phase2_chunk_size)
        .map(|chunk| chunk.to_vec())
        .collect();

    // Fetch all chunks in parallel
    let chunk_futs: Vec<_> = chunks
        .into_iter()
        .map(|chunk| {
            let fetch_futs: Vec<_> = chunk
                .iter()
                .map(|sig| {
                    rpc.get_transaction(
                        &sig.signature,
                        strategy.max_retries,
                        strategy.retry_base_ms,
                    )
                })
                .collect();

            async move {
                let results = futures::future::join_all(fetch_futs).await;
                results.into_iter().filter_map(Result::ok).collect::<Vec<_>>()
            }
        })
        .collect();

    let chunk_results = futures::future::join_all(chunk_futs).await;

    for chunk in chunk_results {
        txs.extend(chunk);
    }

    Ok(txs)
}

/// Dedup by signature
pub fn dedup_by_signature(
    points: Vec<(u64, u64, String, u64, u64)>,
) -> Vec<(u64, u64, String, u64, u64)> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for (block_time, slot, sig, balance, delta) in points {
        if seen.insert(sig.clone()) {
            result.push((block_time, slot, sig, balance, delta));
        }
    }

    // Sort by block_time then slot
    result.sort_by(|a, b| {
        let time_cmp = a.0.cmp(&b.0);
        if time_cmp == std::cmp::Ordering::Equal {
            a.1.cmp(&b.1)
        } else {
            time_cmp
        }
    });

    result
}
