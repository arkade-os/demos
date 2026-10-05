mod esplora;

use ark_bdk_wallet::Wallet;
use ark_client::InMemorySwapStorage;
use ark_client::OffChainBalance;
use ark_client::OfflineClient;
use ark_client::OfflineClientConfig;
use ark_core::asset::ControlAssetConfig;
use ark_core::send::SendReceiver;
use ark_core::Asset;
use ark_rest::Client as RestClient;
use bitcoin::hex::FromHex;
use bitcoin::key::Secp256k1;
use bitcoin::secp256k1::SecretKey;
use bitcoin::Network;
use esplora::EsploraClient;
use std::str::FromStr;
use std::sync::Arc;

// decode from nsec using https://www.nostrly.com/nip-19-entity-decoder/
const PRIVATE_KEY: &str = "";

// specify asset info
const ASSET_NAME: &str = "Rust Test Asset";
const ASSET_TICKER: &str = "RTA";
const ASSET_DECIMALS: u32 = 6;
const ASSET_ICON: &str = "https://i.imgur.com/VxPZvIK.png";

// specify test amounts
const ISSUE_AMOUNT: u64 = 100_000_000; // 100.000000 adjusted for 6 decimals
const REISSUE_AMOUNT: u64 = 123_456; //   0.123456 adjusted for 6 decimals

const DEFAULT_ARK_SERVER_URL: &str = "https://arkade.computer";
const DEFAULT_EXPLORER_URL: &str = "https://arkade.space/tx";

fn default_esplora_url(network: Network) -> &'static str {
    match network {
        Network::Bitcoin => "https://mempool.arkade.sh/api",
        Network::Signet => "https://mempool.mutinynet.arkade.sh/api",
        Network::Testnet => "https://mempool.space/testnet/api",
        _ => "http://127.0.0.1:3000",
    }
}

fn default_boltz_url(network: Network) -> &'static str {
    match network {
        Network::Bitcoin => "https://api.boltz.exchange",
        _ => "https://api.boltz.mutinynet.arkade.sh",
    }
}

type ArkClient = ark_client::Client<EsploraClient, Wallet, InMemorySwapStorage>;

// the SDK takes asset metadata as key-value pairs rather than a typed struct
fn asset_metadata() -> Vec<(String, String)> {
    vec![
        ("name".to_string(), ASSET_NAME.to_string()),
        ("ticker".to_string(), ASSET_TICKER.to_string()),
        ("decimals".to_string(), ASSET_DECIMALS.to_string()),
        ("icon".to_string(), ASSET_ICON.to_string()),
    ]
}

fn decode_metadata(metadata: &str) -> Option<Vec<(String, String)>> {
    let bytes = Vec::<u8>::from_hex(metadata).ok()?;
    let mut cursor = 0;

    let read_uvarint = |cursor: &mut usize| -> Option<u64> {
        let mut value = 0u64;
        let mut shift = 0;
        loop {
            let byte = *bytes.get(*cursor)?;
            *cursor += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
            shift += 7;
            if shift > 63 {
                return None;
            }
        }
    };

    let read_string = |cursor: &mut usize| -> Option<String> {
        let len = read_uvarint(cursor)? as usize;
        let end = cursor.checked_add(len)?;
        let slice = bytes.get(*cursor..end)?;
        *cursor = end;
        String::from_utf8(slice.to_vec()).ok()
    };

    let count = read_uvarint(&mut cursor)?;
    let mut entries = Vec::new();
    for _ in 0..count {
        let key = read_string(&mut cursor)?;
        let value = read_string(&mut cursor)?;
        entries.push((key, value));
    }

    Some(entries)
}

fn metadata_value(metadata: &str, key: &str) -> Option<String> {
    decode_metadata(metadata)?
        .into_iter()
        .find(|(found, _)| found == key)
        .map(|(_, value)| value)
}

// helper for creating human-readable balances
async fn summarize_balances(
    client: &ArkClient,
    balance: &OffChainBalance,
) -> anyhow::Result<String> {
    let bitcoin = format!("{:.8} BTC", balance.total().to_sat() as f64 / 1e8);

    let mut summaries = vec![bitcoin];
    for (asset_id, amount) in balance.asset_balances() {
        let truncated_asset_id = format!("{}...", &asset_id.to_string()[..5]);
        let details = client.get_asset(*asset_id).await.map_err(|e| {
            anyhow::anyhow!("could not fetch details for {truncated_asset_id}: {e}")
        })?;

        let decimals = metadata_value(&details.metadata, "decimals")
            .and_then(|decimals| decimals.parse::<usize>().ok())
            .unwrap_or(0);
        let ticker = metadata_value(&details.metadata, "ticker").unwrap_or(truncated_asset_id);

        let scaled = *amount as f64 / 10f64.powi(decimals as i32);
        summaries.push(format!("{scaled:.decimals$} {ticker}"));
    }

    Ok(serde_json::to_string_pretty(&summaries)?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // esplora talks HTTPS, which needs a crypto provider installed up front
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls crypto provider");

    // create wallet
    let secp = Secp256k1::new();
    let keypair = SecretKey::from_str(PRIVATE_KEY)?.keypair(&secp);

    let ark_server_url =
        std::env::var("ARK_SERVER_URL").unwrap_or_else(|_| DEFAULT_ARK_SERVER_URL.to_string());
    let explorer_url =
        std::env::var("EXPLORER_URL").unwrap_or_else(|_| DEFAULT_EXPLORER_URL.to_string());

    let server_info = RestClient::new(ark_server_url.clone())?.get_info().await?;
    let network = server_info.network;
    let esplora_url =
        std::env::var("ESPLORA_URL").unwrap_or_else(|_| default_esplora_url(network).to_string());

    let blockchain = Arc::new(EsploraClient::new(&esplora_url)?);
    let wallet = Arc::new(Wallet::new(keypair, network, &esplora_url)?);
    let storage = Arc::new(InMemorySwapStorage::new());
    let client = OfflineClient::with_keypair(
        OfflineClientConfig {
            ark_server_url,
            boltz_url: default_boltz_url(network).to_string(),
            ..Default::default()
        },
        keypair,
        blockchain,
        wallet,
        storage,
    )
    .connect()
    .await
    .map_err(|e| anyhow::anyhow!(e))?;

    // get address
    let (address, _) = client
        .get_offchain_address()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!("Created wallet with address: {}", address.encode());
    // get initial balance
    let mut balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched initial balances: {}",
        summarize_balances(&client, &balance).await?
    );

    // burn existing assets
    let mut burn_tx_ids = Vec::new();
    for (asset_id, amount) in balance.asset_balances().clone() {
        let burn_tx_id = client
            .burn_asset(asset_id, amount)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        burn_tx_ids.push(format!("{explorer_url}/{burn_tx_id}"));
    }
    println!(
        "\nBurned {} existing assets: {}",
        burn_tx_ids.len(),
        serde_json::to_string_pretty(&burn_tx_ids)?
    );
    balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched updated balances: {}",
        summarize_balances(&client, &balance).await?
    );

    // create new control asset, and the new asset it controls

    let issuance = client
        .issue_asset(
            ISSUE_AMOUNT,
            Some(ControlAssetConfig::new(1).map_err(|e| anyhow::anyhow!(e))?),
            Some(asset_metadata()),
        )
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let control_asset_id = *issuance
        .asset_ids
        .first()
        .ok_or_else(|| anyhow::anyhow!("issuance returned no control asset id"))?;
    let new_asset_id = *issuance
        .asset_ids
        .get(1)
        .ok_or_else(|| anyhow::anyhow!("issuance returned no asset id"))?;
    // both assets share metadata, so print the ids to tell them apart in the balances
    println!(
        "\nIssued new control asset [{control_asset_id}]: {explorer_url}/{}",
        issuance.ark_txid
    );
    println!(
        "Issued new asset with control asset [{new_asset_id}] in the same transaction: {explorer_url}/{}",
        issuance.ark_txid
    );
    balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched updated balances: {}",
        summarize_balances(&client, &balance).await?
    );

    // reissue same asset
    let reissue_tx_id = client
        .reissue_asset(new_asset_id, REISSUE_AMOUNT)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!("\nReissued same asset with control asset: {explorer_url}/{reissue_tx_id}");
    balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched updated balances: {}",
        summarize_balances(&client, &balance).await?
    );

    // sweep all funds to self
    let assets = balance
        .asset_balances()
        .iter()
        .map(|(asset_id, amount)| Asset {
            asset_id: *asset_id,
            amount: *amount,
        })
        .collect();
    let sweep_tx_id = client
        .send(vec![SendReceiver {
            address,
            // the TS demo sends `balance.available`; the Rust SDK splits that out,
            // and only confirmed plus pre-confirmed funds are spendable offchain
            amount: balance.confirmed() + balance.pre_confirmed(), // assuming zero fees
            assets,
        }])
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!("\nSent everything in wallet to self: {explorer_url}/{sweep_tx_id}");
    balance = client
        .offchain_balance()
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "\nFetched updated balances: {}",
        summarize_balances(&client, &balance).await?
    );

    Ok(())
}
