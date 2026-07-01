use ark_client::key_provider::{KeyProvider, KeypairIndex};
use ark_client::Bip32KeyProvider;
use ark_core::intent::{self, IntentMessage};
use ark_core::script::{csv_sig_script, multisig_3_of_3_script, multisig_script};
use ark_core::server::VirtualTxOutPoint;
use ark_core::{anchor_output, ArkAddress, UNSPENDABLE_KEY};
use ark_delegator::{DelegateOptions, DelegatorClient};
use ark_rest::Client;
use bip39::Mnemonic;
use bitcoin::base64::{engine::general_purpose::STANDARD, Engine};
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::hashes::Hash;
use bitcoin::key::{PublicKey, Secp256k1};
use bitcoin::psbt::PsbtSighashType;
use bitcoin::secp256k1::PublicKey as SecpPublicKey;
use bitcoin::sighash::{Prevouts, SighashCache};
use bitcoin::taproot::{LeafVersion, TaprootBuilder};
use bitcoin::transaction::Version;
use bitcoin::{
    absolute::LockTime, Amount, Psbt, ScriptBuf, Sequence, TapLeafHash, TapSighashType,
    Transaction, TxIn, TxOut, Witness,
};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

const ALICE_SEED: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OPERATOR_URL: &str = "https://mutinynet.arkade.sh";
const DELEGATE_URL: &str = "https://delegator.mutinynet.arkade.sh";
const DUST: u64 = 330;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    println!("Setting up user identity...");
    let mnemonic = Mnemonic::parse_normalized(ALICE_SEED.trim())
        .map_err(|e| anyhow::anyhow!("invalid mnemonic: {e}"))?;
    let seed = mnemonic.to_seed("");
    let secp = Secp256k1::new();

    println!("Connecting to Arkade operator...");
    let client = Client::new(OPERATOR_URL.to_string())?;
    let server_info = client.get_info().await?;
    let network = server_info.network;

    // Derive BIP86 keypair using the SDK's Bip32KeyProvider.
    let coin_type = if network == bitcoin::Network::Bitcoin {
        0u32
    } else {
        1u32
    };
    let master_xpriv = Xpriv::new_master(network, &seed)?;
    let base_path = DerivationPath::from_str(&format!("m/86'/{coin_type}'/0'/0"))?;
    let key_provider = Bip32KeyProvider::new(master_xpriv, base_path);
    let keypair = key_provider
        .get_next_keypair(KeypairIndex::New)
        .map_err(|e| anyhow::anyhow!("key derivation failed: {e}"))?;
    let (user_xonly, _) = keypair.x_only_public_key();

    let server_xonly = server_info.signer_pk.x_only_public_key().0;
    let exit_timelock = server_info.unilateral_exit_delay;
    let forfeit_address = &server_info.forfeit_address;
    let dust = server_info.dust;

    let exit_delay_secs = exit_timelock
        .to_relative_lock_time()
        .and_then(|rt| match rt {
            bitcoin::relative::LockTime::Time(t) => Some(t.value() as u64 * 512),
            _ => None,
        })
        .unwrap_or(exit_timelock.to_consensus_u32() as u64);

    println!(
        "Extracted operator information: {{ operatorPubkey: '{}', exitTimelock: {{ value: {}n, type: 'seconds' }}, forfeitOutscript: '{}' }}",
        hex::encode(server_xonly.serialize()),
        exit_delay_secs,
        hex::encode(forfeit_address.script_pubkey().as_bytes()),
    );

    println!("Connecting to delegate...");
    let delegate_client = DelegatorClient::new(DELEGATE_URL.to_string());
    let delegate_info = delegate_client.info().await?;
    let delegate_compressed_pk = SecpPublicKey::from_slice(&hex::decode(&delegate_info.pubkey)?)?;
    let delegate_xonly = delegate_compressed_pk.x_only_public_key().0;
    let delegate_ark_address = ArkAddress::decode(&delegate_info.delegator_address)?;
    let delegate_fee = delegate_info.fee.parse::<u64>()?;
    println!(
        "Extracted delegate info: [{{ delegatePubkey: '{}', delegateFee: {}n, delegateAddress: '{}' }}]",
        hex::encode(delegate_xonly.serialize()),
        delegate_fee,
        delegate_ark_address.encode(),
    );

    println!("Generating delegated user tapscript...");
    // Build the 3-leaf Taproot tree using btcd's AssembleTaprootScriptTree ordering so the
    // output key matches the TypeScript SDK [forfeit, exit, delegate]
    // This produces depths [2, 2, 1] for the three leaves.
    //
    // Key order in each leaf must also match the TypeScript MultisigTapscript encoder:
    //   forfeit:  [user, server] - user OP_CHECKSIGVERIFY server OP_CHECKSIG
    //   exit:     [user] - <timelock> OP_CSV OP_DROP user OP_CHECKSIG
    //   delegate: [user, delegate, server] - user OP_CHECKSIGVERIFY delegate OP_CHECKSIGVERIFY server OP_CHECKSIG
    let forfeit_script = multisig_script(user_xonly, server_xonly);
    let exit_script = csv_sig_script(exit_timelock, user_xonly);
    let delegate_script = multisig_3_of_3_script(user_xonly, delegate_xonly, server_xonly);

    let unspendable_key: PublicKey = UNSPENDABLE_KEY.parse()?;
    let (unspendable_xonly, _) = unspendable_key.inner.x_only_public_key();

    let mut builder = TaprootBuilder::new();
    builder = builder
        .add_leaf(2, forfeit_script.clone())
        .map_err(|e| anyhow::anyhow!("forfeit leaf error: {e}"))?;
    builder = builder
        .add_leaf(2, exit_script.clone())
        .map_err(|e| anyhow::anyhow!("exit leaf error: {e}"))?;
    builder = builder
        .add_leaf(1, delegate_script.clone())
        .map_err(|e| anyhow::anyhow!("delegate leaf error: {e}"))?;
    let spend_info = builder
        .finalize(&secp, unspendable_xonly)
        .map_err(|_| anyhow::anyhow!("failed to finalize taproot tree"))?;

    let user_address = ArkAddress::new(network, server_xonly, spend_info.output_key());
    println!(
        "Generated delegated user Arkade address: ['{}']",
        user_address.encode()
    );

    println!("Connecting to indexer...");
    println!("Fetching inputs...");

    let vtxo_script_hex = hex::encode(user_address.to_p2tr_script_pubkey().as_bytes());
    let indexer_url = format!(
        "{}/v1/indexer/vtxos?scripts={}",
        OPERATOR_URL, vtxo_script_hex
    );
    let raw_vtxos: serde_json::Value = reqwest::get(&indexer_url)
        .await
        .map_err(|e| anyhow::anyhow!("indexer request failed: {e}"))?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("indexer JSON parse failed: {e}"))?;

    let empty = vec![];
    let vtxo_array = raw_vtxos["vtxos"].as_array().unwrap_or(&empty);

    let inputs: Vec<VirtualTxOutPoint> = vtxo_array
        .iter()
        .filter_map(|v| {
            let txid = v["outpoint"]["txid"].as_str()?.parse().ok()?;
            let vout = v["outpoint"]["vout"].as_u64()? as u32;
            let amount = Amount::from_sat(v["amount"].as_str()?.parse().ok()?);
            let is_preconfirmed = v["isPreconfirmed"].as_bool().unwrap_or(false);
            let is_swept = v["isSwept"].as_bool().unwrap_or(false);
            let is_unrolled = v["isUnrolled"].as_bool().unwrap_or(false);
            let is_spent = v["isSpent"].as_bool().unwrap_or(false);
            let created_at: i64 = v["createdAt"].as_str().unwrap_or("0").parse().ok()?;
            let expires_at: i64 = v["expiresAt"].as_str().unwrap_or("0").parse().ok()?;
            let script = {
                let hex_str = v["script"].as_str()?;
                bitcoin::ScriptBuf::from_hex(hex_str).ok()?
            };

            if is_spent || is_unrolled {
                return None;
            }
            Some(VirtualTxOutPoint {
                outpoint: bitcoin::OutPoint { txid, vout },
                created_at,
                expires_at,
                amount,
                script,
                is_preconfirmed,
                is_swept,
                is_unrolled,
                is_spent,
                spent_by: None,
                commitment_txids: vec![],
                settled_by: None,
                ark_txid: None,
                assets: vec![],
            })
        })
        .collect();

    let input_total: u64 = inputs.iter().map(|v| v.amount.to_sat()).sum();
    println!(
        "Fetched {} inputs: {:?}",
        inputs.len(),
        inputs
            .iter()
            .map(|v| [
                format!("{}:{}", v.outpoint.txid, v.outpoint.vout),
                v.amount.to_sat().to_string()
            ])
            .collect::<Vec<_>>(),
    );

    {
        let change_amount = input_total.saturating_sub(delegate_fee);
        println!(
            "Added change output: ['{}', {}n]",
            user_address.encode(),
            change_amount
        );

        let fee_amount = delegate_fee;
        println!(
            "Added delegate fee output: ['{}', {}n]",
            delegate_ark_address.encode(),
            fee_amount
        );

        if inputs.is_empty() {
            println!("No spendable inputs found. Send funds to the address above and try again.");
            return Ok(());
        }

        let outputs = vec![
            // Change back to the user's delegated address minus the service fee
            intent::Output::Offchain(TxOut {
                value: Amount::from_sat(change_amount),
                script_pubkey: user_address.to_p2tr_script_pubkey(),
            }),
            // Fee to the delegate's on-chain collection address
            intent::Output::Offchain(TxOut {
                value: Amount::from_sat(fee_amount),
                script_pubkey: delegate_ark_address.to_p2tr_script_pubkey(),
            }),
        ];

        let valid_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        let message = IntentMessage::Register {
            onchain_output_indexes: vec![],
            valid_at,
            expire_at: 0,
            own_cosigner_pks: vec![delegate_compressed_pk],
        };

        let forfeit_cb = spend_info
            .control_block(&(forfeit_script.clone(), LeafVersion::TapScript))
            .ok_or_else(|| anyhow::anyhow!("no control block for forfeit leaf"))?;

        let tapscripts = vec![
            forfeit_script.clone(),
            exit_script.clone(),
            delegate_script.clone(),
        ];

        let intent_inputs: Vec<intent::Input> = inputs
            .iter()
            .map(|vtxo| {
                Ok(intent::Input::new(
                    vtxo.outpoint,
                    Sequence::ZERO,
                    None,
                    TxOut {
                        value: vtxo.amount,
                        script_pubkey: user_address.to_p2tr_script_pubkey(),
                    },
                    tapscripts.clone(),
                    (forfeit_script.clone(), forfeit_cb.clone()),
                    false,
                    vtxo.is_swept,
                    vec![],
                ))
            })
            .collect::<anyhow::Result<_>>()?;

        // Sign the intent proof with the user's key over the forfeit leaf
        let signed_intent = intent::make_intent(
            |_psbt_input, msg| {
                let sig = secp.sign_schnorr_no_aux_rand(&msg, &keypair);
                Ok(vec![(sig, user_xonly)])
            },
            |_psbt_input, _msg| Err(ark_core::Error::ad_hoc("no onchain inputs expected")),
            intent_inputs,
            outputs,
            message.clone(),
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?;

        println!(
            "Generated signed delegate intent: {{ proof: '{}', message: {} }}",
            signed_intent.serialize_proof(),
            signed_intent
                .serialize_message()
                .map_err(|e| anyhow::anyhow!("{e}"))?,
        );

        // Build pre-signed forfeit PSBTs for non-recoverable inputs using the delegate leaf.
        let delegate_cb = spend_info
            .control_block(&(delegate_script.clone(), LeafVersion::TapScript))
            .ok_or_else(|| anyhow::anyhow!("no control block for delegate leaf"))?;

        let vtxo_script_pubkey = user_address.to_p2tr_script_pubkey();

        let forfeit_psbts: Vec<Psbt> = inputs
            .iter()
            .filter(|v| !v.is_recoverable(dust))
            .map(|vtxo| {
                let unsigned_tx = Transaction {
                    version: Version::non_standard(3),
                    lock_time: LockTime::ZERO,
                    input: vec![TxIn {
                        previous_output: vtxo.outpoint,
                        script_sig: ScriptBuf::new(),
                        sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                        witness: Witness::default(),
                    }],
                    output: vec![
                        TxOut {
                            value: vtxo.amount + Amount::from_sat(DUST),
                            script_pubkey: forfeit_address.script_pubkey(),
                        },
                        anchor_output(),
                    ],
                };

                let mut psbt =
                    Psbt::from_unsigned_tx(unsigned_tx).map_err(|e| anyhow::anyhow!("{e}"))?;

                let witness_utxo = TxOut {
                    value: vtxo.amount,
                    script_pubkey: vtxo_script_pubkey.clone(),
                };

                psbt.inputs[0].witness_utxo = Some(witness_utxo.clone());
                psbt.inputs[0].sighash_type =
                    Some(PsbtSighashType::from(TapSighashType::AllPlusAnyoneCanPay));
                psbt.inputs[0].tap_scripts.insert(
                    delegate_cb.clone(),
                    (delegate_script.clone(), LeafVersion::TapScript),
                );

                // Compute the tapscript sighash over the delegate leaf and sign
                let leaf_hash = TapLeafHash::from_script(&delegate_script, LeafVersion::TapScript);
                let prevouts = [witness_utxo];
                let sighash = SighashCache::new(&psbt.unsigned_tx)
                    .taproot_script_spend_signature_hash(
                        0,
                        &Prevouts::All(&prevouts),
                        leaf_hash,
                        TapSighashType::AllPlusAnyoneCanPay,
                    )
                    .map_err(|e| anyhow::anyhow!("{e}"))?;

                let msg =
                    bitcoin::secp256k1::Message::from_digest(sighash.to_raw_hash().to_byte_array());
                let sig = secp.sign_schnorr_no_aux_rand(&msg, &keypair);

                psbt.inputs[0].tap_script_sigs.insert(
                    (user_xonly, leaf_hash),
                    bitcoin::taproot::Signature {
                        signature: sig,
                        sighash_type: TapSighashType::AllPlusAnyoneCanPay,
                    },
                );

                Ok(psbt)
            })
            .collect::<anyhow::Result<_>>()?;

        println!(
            "Generated signed forfeit transactions: {:?}",
            forfeit_psbts
                .iter()
                .map(|p| STANDARD.encode(p.serialize()))
                .collect::<Vec<_>>()
        );

        delegate_client
            .delegate(
                &signed_intent,
                &forfeit_psbts,
                Some(DelegateOptions::default()),
            )
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;

        println!("Delegated!");
    }

    Ok(())
}
