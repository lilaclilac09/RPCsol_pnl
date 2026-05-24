// sol_balance_scout_rust/src/types.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignatureInfo {
    pub signature: String,
    pub slot: u64,
    #[serde(rename = "blockTime")]
    pub block_time: Option<u64>,
    pub err: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionMeta {
    pub err: Option<serde_json::Value>,
    #[serde(rename = "preBalances")]
    pub pre_balances: Vec<u64>,
    #[serde(rename = "postBalances")]
    pub post_balances: Vec<u64>,
    pub fee: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountKey {
    pub pubkey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionMessage {
    #[serde(rename = "accountKeys")]
    pub account_keys: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionData {
    pub signatures: Vec<String>,
    pub message: TransactionMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullTransaction {
    pub slot: u64,
    #[serde(rename = "blockTime")]
    pub block_time: Option<u64>,
    pub transaction: TransactionData,
    pub meta: TransactionMeta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BalancePoint {
    pub block_time: u64,
    pub slot: u64,
    pub balance_lamports: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct SolBalance {
    pub lamports: u64,
}

impl SolBalance {
    pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

    pub fn to_sol(&self) -> f64 {
        self.lamports as f64 / Self::LAMPORTS_PER_SOL as f64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryStats {
    pub total_rpc_calls: usize,
    pub phase0_calls: usize,
    pub phase1_calls: usize,
    pub phase2_calls: usize,
    pub signatures_discovered: usize,
    pub sample_count: usize,
    pub wall_time_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolBalanceHistory {
    pub address: String,
    pub points: Vec<HashMap<String, serde_json::Value>>,
    pub opening_balance_lamports: u64,
    pub closing_balance_lamports: u64,
    pub stats: HistoryStats,
}

#[derive(Debug, Clone)]
pub struct RpcResponse<T> {
    pub jsonrpc: String,
    pub result: Option<T>,
    pub error: Option<RpcError>,
    pub id: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

#[derive(Debug, Clone, Copy)]
pub struct Strategy {
    pub max_concurrency: usize,
    pub max_retries: usize,
    pub retry_base_ms: u64,
    pub phase0_sig_limit: usize,
    pub phase1_target_density: f64,  // sigs per second
    pub phase2_chunk_size: usize,
}

impl Default for Strategy {
    fn default() -> Self {
        Self {
            max_concurrency: 100,
            max_retries: 4,
            retry_base_ms: 150,
            phase0_sig_limit: 1000,
            phase1_target_density: 50.0,
            phase2_chunk_size: 50,
        }
    }
}
