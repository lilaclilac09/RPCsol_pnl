// sol_balance_scout_rust/src/lib.rs
pub mod algorithm;
pub mod rpc;
pub mod types;

pub use algorithm::{dedup_by_signature, phase0, phase1, phase2};
pub use rpc::RpcClient;
pub use types::{FullTransaction, SolBalance, Strategy, HistoryStats, SolBalanceHistory};
