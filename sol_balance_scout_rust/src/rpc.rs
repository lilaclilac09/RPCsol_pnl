// sol_balance_scout_rust/src/rpc.rs
use anyhow::{anyhow, Result};
use reqwest::Client;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::time::{sleep, Duration};

use crate::types::{FullTransaction, RpcResponse, SignatureInfo};

pub struct RpcClient {
    client: Client,
    url: String,
    semaphore: Arc<Semaphore>,
    call_count: Arc<AtomicUsize>,
}

impl RpcClient {
    pub fn new(api_key: &str, max_concurrency: usize) -> Self {
        let url = format!("https://mainnet.helius-rpc.com/?api-key={}", api_key);
        
        Self {
            client: Client::new(),
            url,
            semaphore: Arc::new(Semaphore::new(max_concurrency)),
            call_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    async fn post_with_retry<T: serde::de::DeserializeOwned>(
        &self,
        body: serde_json::Value,
        max_retries: usize,
        retry_base_ms: u64,
    ) -> Result<T> {
        // Acquire semaphore slot
        let _permit = self.semaphore.acquire().await?;
        self.call_count.fetch_add(1, Ordering::Relaxed);

        for attempt in 0..=max_retries {
            match self.client.post(&self.url).json(&body).send().await {
                Ok(response) => {
                    if !response.status().is_success() {
                        let err_text = response.text().await.unwrap_or_default();
                        if attempt < max_retries {
                            let is_transient = response.status().as_u16() == 429
                                || response.status().as_u16() == 503;
                            if is_transient {
                                // Back off and retry
                                let delay_ms = retry_base_ms * 2_u64.pow(attempt as u32);
                                sleep(Duration::from_millis(delay_ms)).await;
                                continue;
                            }
                        }
                        return Err(anyhow!(
                            "HTTP {}: {}",
                            response.status(),
                            err_text.chars().take(120).collect::<String>()
                        ));
                    }

                    let json: serde_json::Value = response.json().await?;
                    
                    if let Some(error) = json.get("error").and_then(|v| v.as_object()) {
                        if attempt < max_retries {
                            let code = error.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
                            if code == -32429 || code == 429 {
                                let delay_ms = retry_base_ms * 2_u64.pow(attempt as u32);
                                sleep(Duration::from_millis(delay_ms)).await;
                                continue;
                            }
                        }
                        return Err(anyhow!(
                            "RPC error: {}",
                            serde_json::to_string(error).unwrap_or_default()
                        ));
                    }

                    return json
                        .get("result")
                        .ok_or_else(|| anyhow!("No result field in RPC response"))?
                        .clone()
                        .try_into()
                        .map_err(|_| anyhow!("Failed to deserialize RPC response"));
                }
                Err(e) => {
                    let msg = e.to_string();
                    let is_transient = msg.contains("timeout")
                        || msg.contains("ECONNRESET")
                        || msg.contains("connect");

                    if is_transient && attempt < max_retries {
                        let delay_ms = retry_base_ms * 2_u64.pow(attempt as u32);
                        sleep(Duration::from_millis(delay_ms)).await;
                        continue;
                    }

                    return Err(e.into());
                }
            }
        }

        Err(anyhow!("Max retries exceeded"))
    }

    pub async fn get_signatures(
        &self,
        address: &str,
        limit: usize,
        before: Option<&str>,
        max_retries: usize,
        retry_base_ms: u64,
    ) -> Result<Vec<SignatureInfo>> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getSignaturesForAddress",
            "params": [
                address,
                {
                    "limit": limit,
                    "before": before
                }
            ]
        });

        self.post_with_retry(body, max_retries, retry_base_ms)
            .await
    }

    pub async fn get_transaction(
        &self,
        signature: &str,
        max_retries: usize,
        retry_base_ms: u64,
    ) -> Result<FullTransaction> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                signature,
                {
                    "encoding": "jsonParsed",
                    "maxSupportedTransactionVersion": 0
                }
            ]
        });

        self.post_with_retry(body, max_retries, retry_base_ms)
            .await
    }

    pub fn call_count(&self) -> usize {
        self.call_count.load(Ordering::Relaxed)
    }
}
