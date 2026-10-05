use ark_client::Blockchain;
use ark_client::Error;
use ark_client::SpendStatus;
use ark_client::TxStatus;
use ark_core::ExplorerUtxo;
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::Address;
use bitcoin::Amount;
use bitcoin::OutPoint;
use bitcoin::Transaction;
use bitcoin::Txid;
use std::collections::HashSet;

/// Relay requires at least 1 sat/vB, so never estimate below it.
const MIN_FEE_RATE: f64 = 1.0;

/// Highest fee rate accepted from the explorer, matching the Go SDK's bound.
const MAX_FEE_RATE: f64 = 10_000.0;

/// A minimal Esplora-backed [`Blockchain`] implementation.
///
/// `ark_client::Client` is generic over its chain source and the SDK does not ship a
/// ready-made one, so every consumer supplies its own. This is adapted from the
/// `ark-client-sample` crate in the Rust SDK repo.
pub struct EsploraClient {
    esplora_client: esplora_client::AsyncClient,
    /// `esplora-client` has no package-submission endpoint, so `broadcast_package`
    /// posts to the REST API directly and needs the base URL and its own client.
    http_client: reqwest::Client,
    base_url: String,
}

impl EsploraClient {
    pub fn new(url: &str) -> anyhow::Result<Self> {
        let builder = esplora_client::Builder::new(url);
        let esplora_client = builder.build_async()?;

        Ok(Self {
            esplora_client,
            http_client: reqwest::Client::new(),
            base_url: url.trim_end_matches('/').to_string(),
        })
    }
}

impl Blockchain for EsploraClient {
    async fn find_outpoints(&self, address: &Address) -> Result<Vec<ExplorerUtxo>, Error> {
        let current_block_height = self
            .esplora_client
            .get_height()
            .await
            .map_err(Error::consumer)?;

        let script_pubkey = address.script_pubkey();
        let txs = self
            .esplora_client
            .scripthash_txs(&script_pubkey, None)
            .await
            .map_err(Error::consumer)?;

        let spent_outpoints: HashSet<OutPoint> = txs
            .iter()
            .flat_map(|tx| {
                tx.vin
                    .iter()
                    .filter(|input| {
                        input
                            .prevout
                            .as_ref()
                            .is_some_and(|prevout| prevout.scriptpubkey == script_pubkey)
                    })
                    .map(|input| OutPoint {
                        txid: input.txid,
                        vout: input.vout,
                    })
            })
            .collect();

        let utxos = txs
            .into_iter()
            .flat_map(|tx| {
                let txid = tx.txid;
                tx.vout
                    .iter()
                    .enumerate()
                    .filter(|(_, v)| v.scriptpubkey == script_pubkey)
                    .map(|(i, v)| {
                        let outpoint = OutPoint {
                            txid,
                            vout: i as u32,
                        };
                        let confirmations = match tx.status.block_height {
                            Some(confirmation_block_height) => {
                                match current_block_height.checked_sub(confirmation_block_height) {
                                    Some(x) => x + 1,
                                    None => 0,
                                }
                            }
                            None => 0,
                        };

                        ExplorerUtxo {
                            outpoint,
                            amount: Amount::from_sat(v.value),
                            confirmation_blocktime: tx.status.block_time,
                            confirmations: confirmations as u64,
                            is_spent: spent_outpoints.contains(&outpoint),
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        Ok(utxos)
    }

    async fn find_tx(&self, txid: &Txid) -> Result<Option<Transaction>, Error> {
        let option = self
            .esplora_client
            .get_tx(txid)
            .await
            .map_err(Error::consumer)?;

        Ok(option)
    }

    async fn get_tx_status(&self, txid: &Txid) -> Result<TxStatus, Error> {
        let info = self
            .esplora_client
            .get_tx_info(txid)
            .await
            .map_err(Error::consumer)?;

        Ok(TxStatus {
            confirmed_at: info.and_then(|s| s.status.block_time.map(|t| t as i64)),
        })
    }

    async fn get_output_status(&self, txid: &Txid, vout: u32) -> Result<SpendStatus, Error> {
        let status = self
            .esplora_client
            .get_output_status(txid, vout as u64)
            .await
            .map_err(Error::consumer)?;

        Ok(SpendStatus {
            spend_txid: status.as_ref().and_then(|s| s.txid),
        })
    }

    async fn broadcast(&self, tx: &Transaction) -> Result<(), Error> {
        self.esplora_client
            .broadcast(tx)
            .await
            .map_err(Error::consumer)?;

        Ok(())
    }

    async fn get_fee_rate(&self) -> Result<f64, Error> {
        let estimates = self
            .esplora_client
            .get_fee_estimates()
            .await
            .map_err(Error::consumer)?;

        let fee_rate = [1u16, 2, 3, 6]
            .iter()
            .find_map(|target| estimates.get(target).copied())
            .unwrap_or(MIN_FEE_RATE);

        // Reject rates that cannot be turned into a fee amount.
        if !fee_rate.is_finite() || !(0.0..=MAX_FEE_RATE).contains(&fee_rate) {
            return Err(Error::consumer(format!(
                "fee rate out of range: {fee_rate} sat/vB"
            )));
        }

        Ok(fee_rate.max(MIN_FEE_RATE))
    }

    async fn broadcast_package(&self, txs: &[&Transaction]) -> Result<(), Error> {
        // Unilateral exit broadcasts a parent and its fee-bumping child together.
        // They have to be submitted as one package: the parent pays almost no fee
        // on its own and would be rejected if sent by itself.
        //
        // `esplora-client` has no method for this, so post to the same endpoint the
        // TS SDK (`EsploraProvider.broadcastPackage`) and the Go SDK
        // (`explorerSvc.broadcastPackage`) use: a JSON array of raw transaction hex.
        let txs_hex = txs.iter().map(|tx| serialize_hex(*tx)).collect::<Vec<_>>();

        let response = self
            .http_client
            .post(format!("{}/txs/package", self.base_url))
            .json(&txs_hex)
            .send()
            .await
            .map_err(Error::consumer)?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(Error::consumer(format!(
                "failed to broadcast package ({status}): {body}"
            )));
        }

        Ok(())
    }
}
