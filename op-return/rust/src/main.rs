use ark_core::script::{multisig_script, tr_script_pubkey};
use ark_core::send::{
    build_offchain_transactions, sign_ark_transaction, sign_checkpoint_transaction, SendReceiver,
    VtxoInput,
};
use ark_core::server::GetVtxosRequest;
use ark_core::{anchor_output, ArkAddress, UNSPENDABLE_KEY};
use ark_rest::Client;
use bip39::Mnemonic;
use bitcoin::base64::{engine::general_purpose::STANDARD, Engine};
use bitcoin::key::{Keypair, PublicKey, Secp256k1};
use bitcoin::script::PushBytesBuf;
use bitcoin::taproot::LeafVersion;
use bitcoin::{
    bip32::{DerivationPath, Xpriv, Xpub},
    psbt, Amount, Network, ScriptBuf, TxOut, XOnlyPublicKey,
};
use std::str::FromStr;
use std::time::Duration;

const ALICE_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ARK_SERVER_URL: &str = "https://arkade.computer";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let secp = Secp256k1::new();

    println!("Connecting to operator...");
    let client = Client::new(ARK_SERVER_URL.to_string())?;
    let server_info = client.get_info().await?;

    println!("Setting up operator identity...");
    let server_xonly = server_info.signer_pk.x_only_public_key().0;

    println!("Setting up Alice identity...");
    let mnemonic: Mnemonic = ALICE_MNEMONIC.parse()?;
    let seed = mnemonic.to_seed("");
    let master_xpriv = Xpriv::new_master(Network::Bitcoin, &seed)?;
    let path = DerivationPath::from_str("m/86'/0'/0'/0/0")?;
    let child_xpriv = master_xpriv.derive_priv(&secp, &path)?;
    let xpub = Xpub::from_priv(&secp, &child_xpriv);
    let user_xonly = xpub.public_key.x_only_public_key().0;
    let keypair = Keypair::from_secret_key(&secp, &child_xpriv.private_key);
    let (alice_xonly, _) = keypair.x_only_public_key();

    println!("Generating simple address with collaborative spend path...");
    let unspendable_key: PublicKey = UNSPENDABLE_KEY.parse()?;
    let (unspendable_xonly, _) = unspendable_key.inner.x_only_public_key();

    let collaborative_script = multisig_script(server_xonly, user_xonly);

    let mut builder = bitcoin::taproot::TaprootBuilder::new();
    builder = builder
        .add_leaf(0, collaborative_script.clone())
        .map_err(|e| anyhow::anyhow!("leaf error: {e}"))?;
    let spend_info = builder
        .finalize(&secp, unspendable_xonly)
        .map_err(|_| anyhow::anyhow!("failed to finalize taproot"))?;

    let script_pubkey = tr_script_pubkey(&spend_info);
    let self_address = ArkAddress::new(Network::Bitcoin, server_xonly, spend_info.output_key());
    println!("Generated address: ['{}']", self_address.encode());

    println!("Connecting to indexer...");
    println!("Checking spendable balance in address...");

    let vtxos_response = client
        .list_vtxos(
            GetVtxosRequest::new_for_addresses(std::iter::once(self_address))
                .spendable_only()
                .map_err(|e| anyhow::anyhow!("{e}"))?,
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let vtxos = vtxos_response.vtxos;
    let balance: u64 = vtxos.iter().map(|v| v.amount.to_sat()).sum();
    println!("Spendable balance: {balance}");

    if balance == 0 {
        return Ok(());
    }

    let balance = Amount::from_sat(balance);

    let vtxo_inputs: Vec<VtxoInput> = vtxos
        .iter()
        .map(|vtxo| {
            let control_block = spend_info
                .control_block(&(collaborative_script.clone(), LeafVersion::TapScript))
                .expect("control block for collaborative script");

            VtxoInput::new(
                collaborative_script.clone(),
                None,
                control_block,
                vec![collaborative_script.clone()],
                script_pubkey.clone(),
                vtxo.amount,
                vtxo.outpoint,
                vec![],
            )
        })
        .collect();

    let self_address = ArkAddress::new(Network::Bitcoin, server_xonly, spend_info.output_key());

    let subdust_receiver = SendReceiver::bitcoin(self_address.clone(), Amount::from_sat(1));
    let change_receiver =
        SendReceiver::bitcoin(self_address.clone(), balance - Amount::from_sat(1));

    println!("Generating transaction...");
    let mut offchain_txs = build_offchain_transactions(
        &[subdust_receiver, change_receiver],
        &self_address,
        &vtxo_inputs,
        &server_info,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;

    let data = b"hello world!";
    let push_bytes = PushBytesBuf::try_from(data.to_vec())
        .map_err(|_| anyhow::anyhow!("data too large for OP_RETURN"))?;
    let op_return_script = ScriptBuf::new_op_return(&push_bytes);

    let anchor_index = offchain_txs.ark_tx.unsigned_tx.output.len() - 1;
    offchain_txs.ark_tx.unsigned_tx.output.insert(
        anchor_index,
        TxOut {
            value: Amount::ZERO,
            script_pubkey: op_return_script,
        },
    );
    offchain_txs
        .ark_tx
        .outputs
        .insert(anchor_index, psbt::Output::default());

    let ark_tx_b64 = STANDARD.encode(offchain_txs.ark_tx.serialize());
    println!("Generated Arkade transaction: ['{ark_tx_b64}']");
    let checkpoint_b64s: Vec<String> = offchain_txs
        .checkpoint_txs
        .iter()
        .map(|tx| STANDARD.encode(tx.serialize()))
        .collect();
    println!("Generated unsigned checkpoint transactions: {checkpoint_b64s:?}");

    println!("Signing with Alice...");
    for i in 0..offchain_txs.ark_tx.inputs.len() {
        sign_ark_transaction(
            |_input, msg| {
                let sig = secp.sign_schnorr_no_aux_rand(&msg, &keypair);
                Ok(vec![(sig, alice_xonly)])
            },
            &mut offchain_txs.ark_tx,
            i,
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    }

    let signed_ark_tx_b64 = STANDARD.encode(offchain_txs.ark_tx.serialize());
    println!("Signed Arkade transaction: ['{signed_ark_tx_b64}']");

    println!("Submitting Arkade transaction with unsigned checkpoint transactions to operator...");
    let response = client
        .submit_offchain_transaction_request(offchain_txs.ark_tx, offchain_txs.checkpoint_txs)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let signed_checkpoint_b64s: Vec<String> = response
        .signed_checkpoint_txs
        .iter()
        .map(|tx| STANDARD.encode(tx.serialize()))
        .collect();
    println!("Received signed checkpoint transactions: {signed_checkpoint_b64s:?}");

    println!("Finalizing signed checkpoint transactions...");
    let mut finalized_checkpoints = Vec::new();
    for mut checkpoint_psbt in response.signed_checkpoint_txs {
        println!("Finalizing checkpoint transaction with Alice...");
        sign_checkpoint_transaction(
            |_input, msg| {
                let sig = secp.sign_schnorr_no_aux_rand(&msg, &keypair);
                Ok(vec![(sig, alice_xonly)])
            },
            &mut checkpoint_psbt,
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?;
        finalized_checkpoints.push(checkpoint_psbt);
    }

    let finalized_b64s: Vec<String> = finalized_checkpoints
        .iter()
        .map(|tx| STANDARD.encode(tx.serialize()))
        .collect();
    println!("Finalized checkpoint transactions: {finalized_b64s:?}");

    let txid = response.signed_ark_tx.unsigned_tx.compute_txid();

    println!("Finalizing transaction...");
    client
        .finalize_offchain_transaction(txid, finalized_checkpoints)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("Broadcasted! https://arkade.space/tx/{txid}");

    println!("Sleeping for 3 seconds...");
    tokio::time::sleep(Duration::from_secs(3)).await;

    println!("Fetching transaction outputs...");
    let virtual_txs = client
        .get_virtual_txs(vec![txid.to_string()], None)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    if virtual_txs.txs.is_empty() {
        eprintln!("Could not find transaction");
    } else {
        let tx = &virtual_txs.txs[0];
        let anchor_script = anchor_output().script_pubkey;

        for (vout, output) in tx.unsigned_tx.output.iter().enumerate() {
            let amount = output.value.to_sat();
            let script = &output.script_pubkey;

            if script == &anchor_script {
                println!("Found anchor output at index #{vout} with amount {amount}");
                continue;
            }

            if let Some(pubkey) = parse_p2tr_pubkey(script) {
                let address = ArkAddress::new(
                    Network::Bitcoin,
                    server_xonly,
                    bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(pubkey),
                );
                println!(
                    "Found standard payment at index #{vout} with amount {amount} ['{}']",
                    address.encode()
                );
                continue;
            }

            if let Some(data) = parse_op_return(script) {
                if data.len() == 32 {
                    let pubkey = XOnlyPublicKey::from_slice(&data)
                        .map_err(|e| anyhow::anyhow!("invalid subdust pubkey: {e}"))?;
                    let address = ArkAddress::new(
                        Network::Bitcoin,
                        server_xonly,
                        bitcoin::key::TweakedPublicKey::dangerous_assume_tweaked(pubkey),
                    );
                    println!(
                        "Found subdust payment at index #{vout} with amount {amount} ['{}']",
                        address.encode()
                    );
                } else {
                    let message = String::from_utf8_lossy(&data);
                    println!(
                        "Found op_return output at index #{vout} with amount {amount} ['{message}']"
                    );
                }
                continue;
            }

            eprintln!("Could not decode output at index #{vout} with amount {amount}: {script}");
        }
    }

    Ok(())
}

fn parse_p2tr_pubkey(script: &ScriptBuf) -> Option<XOnlyPublicKey> {
    let bytes = script.as_bytes();
    if bytes.len() == 34 && bytes[0] == 0x51 && bytes[1] == 0x20 {
        XOnlyPublicKey::from_slice(&bytes[2..]).ok()
    } else {
        None
    }
}

fn parse_op_return(script: &ScriptBuf) -> Option<Vec<u8>> {
    let bytes = script.as_bytes();
    if bytes.first() == Some(&0x6a) {
        Some(bytes[1..].to_vec())
    } else {
        None
    }
}
