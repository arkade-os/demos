use ark_core::send::{
    build_offchain_transactions, sign_ark_transaction, sign_checkpoint_transaction, SendReceiver,
    VtxoInput,
};
use ark_core::server::{parse_sequence_number, GetVtxosRequest};
use ark_core::vhtlc::{VhtlcOptions, VhtlcScript};
use ark_core::{Vtxo, VTXO_CONDITION_KEY};
use ark_delegator::DelegatorClient;
use ark_rest::Client;
use bip39::Mnemonic;
use bitcoin::base64::{engine::general_purpose::STANDARD, Engine};
use bitcoin::hashes::{ripemd160, sha256, Hash};
use bitcoin::key::{Keypair, PublicKey as BtcPublicKey, Secp256k1};
use bitcoin::secp256k1::{schnorr, Message, PublicKey as SecpPublicKey};
use bitcoin::taproot::{LeafVersion, TaprootBuilder};
use bitcoin::{
    address::NetworkUnchecked,
    bip32::{DerivationPath, Xpriv},
    consensus::Encodable,
    io::Write as _,
    psbt, Address, Amount, Network, ScriptBuf, VarInt, XOnlyPublicKey,
};
use serde::Deserialize;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

const PREIMAGE: &str = "65d4240a1fa11515f70e8e7f96d287f8583bb701858551bebdafdc78873a619f";
const REFUND_LOCKTIME: u32 = 1783959716;
const ARKADE_BOLTZ_PUBKEY_COMPRESSED: &str =
    "03f06b63aed9643c3a726f3973c3bfbaf2ac1a5bed618966e14f11de19746885a0";
const ARKADE_UNILATERAL_CLAIM_DELAY_SECONDS: u32 = 4096;
const ARKADE_UNILATERAL_REFUND_DELAY_SECONDS: u32 = 4608;
const ARKADE_UNILATERAL_REFUND_WITHOUT_RECEIVER_DELAY_SECONDS: u32 = 5120;
const LOCKUP_PUBKEY_COMPRESSED: &str =
    "030d6a0a348fde9e9597001cba8b7d9aa8756b82ad75507009b243d71b30c704a7";
const LOCKUP_CLAIM_LEAF_SCRIPT: &str = "82012088a914751a19caf711b64618ca8cf892edaa370a01d9af88200d6a0a348fde9e9597001cba8b7d9aa8756b82ad75507009b243d71b30c704a7ac";
const LOCKUP_REFUND_LEAF_SCRIPT: &str =
    "20cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115ad03e0b731b1";

const SWAP_AMOUNT: u64 = 2_500;
/// from faucet.mutinynet.com
const MAINNET_ADDRESS: &str = "tb1qmt3ue2senlg6ddgmr76hwsk0rdvdk4rgeaen7l";
const ALICE_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const OPERATOR_URL: &str = "https://mutinynet.arkade.sh";
const DELEGATE_URL: &str = "https://delegator.mutinynet.arkade.sh";
const BOLTZ_API: &str = "https://api.boltz.mutinynet.arkade.sh";
const MEMPOOL_API: &str = "https://mempool.mutinynet.arkade.sh/api";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeoutBlockHeights {
    refund: u32,
    unilateral_claim: u32,
    unilateral_refund: u32,
    unilateral_refund_without_receiver: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimDetails {
    /// Amount to be received on Arkade.
    amount: u64,
    /// Arkade lockup address where Boltz will lock funds.
    lockup_address: String,
    /// Boltz's public key for the claim script.
    server_public_key: String,
    /// Block heights for various timeout/refund scenarios.
    timeouts: TimeoutBlockHeights,
}

#[derive(Debug, Deserialize)]
struct SwapTreeLeaf {
    version: u8,
    output: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwapTree {
    claim_leaf: SwapTreeLeaf,
    refund_leaf: SwapTreeLeaf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockupDetails {
    /// Amount to be paid on mainnet.
    amount: u64,
    /// Mainnet lockup address where the user will send funds.
    lockup_address: String,
    /// Boltz's public key for the lockup script.
    server_public_key: String,
    /// Taproot script tree, used to reconstruct the address.
    swap_tree: SwapTree,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChainSwapResponse {
    claim_details: ClaimDetails,
    lockup_details: LockupDetails,
}

#[derive(Debug, Deserialize)]
struct ChainSwapLimits {
    #[serde(rename = "BTC")]
    btc: ChainSwapLimitsArk,
}
#[derive(Debug, Deserialize)]
struct ChainSwapLimitsArk {
    #[serde(rename = "ARK")]
    ark: ChainSwapLimitsInner,
}
#[derive(Debug, Deserialize)]
struct ChainSwapLimitsInner {
    limits: ChainSwapLimitsValues,
}
#[derive(Debug, Deserialize)]
struct ChainSwapLimitsValues {
    maximal: u64,
    minimal: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecommendedFees {
    fastest_fee: u64,
}

fn reconstruct_mainnet_lockup_address(
    server_pk_compressed: BtcPublicKey,
    user_pk_compressed: BtcPublicKey,
    claim_script: ScriptBuf,
    refund_script: ScriptBuf,
    network: Network,
) -> anyhow::Result<Address> {
    let musig_server_pk = musig::PublicKey::from_slice(&server_pk_compressed.to_bytes())?;
    let musig_user_pk = musig::PublicKey::from_slice(&user_pk_compressed.to_bytes())?;

    let key_agg = musig::musig::KeyAggCache::new(&[&musig_server_pk, &musig_user_pk]);
    let internal_key = XOnlyPublicKey::from_slice(&key_agg.agg_pk().serialize())?;

    let secp = Secp256k1::new();
    let spend_info = TaprootBuilder::new()
        .add_leaf(1, claim_script)
        .map_err(|e| anyhow::anyhow!("failed to add claim leaf: {e}"))?
        .add_leaf(1, refund_script)
        .map_err(|e| anyhow::anyhow!("failed to add refund leaf: {e}"))?
        .finalize(&secp, internal_key)
        .map_err(|_| anyhow::anyhow!("failed to finalize taproot tree"))?;

    Ok(Address::p2tr(
        &secp,
        spend_info.internal_key(),
        spend_info.merkle_root(),
        network,
    ))
}

fn set_condition_witness(input: &mut psbt::Input, preimage: [u8; 32]) {
    // Initialized with a 1, because we only have one witness element: the preimage.
    let mut bytes = vec![1u8];
    VarInt::from(preimage.len() as u64)
        .consensus_encode(&mut bytes)
        .expect("valid length encoding");
    bytes.write_all(&preimage).expect("valid preimage encoding");

    input.unknown.insert(
        psbt::raw::Key {
            type_value: 222,
            key: VTXO_CONDITION_KEY.to_vec(),
        },
        bytes,
    );
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let secp = Secp256k1::new();

    println!("Connecting to Arkade operator...");
    let operator = Client::new(OPERATOR_URL.to_string())?;
    let server_info = operator.get_info().await?;
    let network = server_info.network;
    let operator_xonly = server_info.signer_pk.x_only_public_key().0;
    println!("Operator public key: ['{}']", hex::encode(operator_xonly.serialize()));

    /* Verify `MAINNET_ADDRESS` (used for refund) */
    println!("Extracting mainnet pkScript: ['{MAINNET_ADDRESS}']");
    let mainnet_address: Address = MAINNET_ADDRESS
        .parse::<Address<NetworkUnchecked>>()
        .map_err(|_| anyhow::anyhow!("Invalid MAINNET_ADDRESS: {MAINNET_ADDRESS}"))?
        .require_network(network)
        .map_err(|_| anyhow::anyhow!("Invalid MAINNET_ADDRESS: {MAINNET_ADDRESS}"))?;
    let _mainnet_pk_script = mainnet_address.script_pubkey();

    let is_new_swap = hex::decode(PREIMAGE)
        .map(|bytes| bytes.len() != 32)
        .unwrap_or(true);
    let preimage: [u8; 32] = if is_new_swap {
        rand::random()
    } else {
        hex::decode(PREIMAGE)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid PREIMAGE"))?
    };

    if !is_new_swap {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        if REFUND_LOCKTIME == 0 || (now as u32) > REFUND_LOCKTIME {
            anyhow::bail!(
                "REFUND_LOCKTIME must be set to a valid future timestamp if PREIMAGE is defined (got {REFUND_LOCKTIME})"
            );
        }
        if hex::decode(ARKADE_BOLTZ_PUBKEY_COMPRESSED)?.len() != 33 {
            anyhow::bail!(
                "ARKADE_BOLTZ_PUBKEY_COMPRESSED must be set to a valid 33-byte compressed public key if PREIMAGE is defined"
            );
        }
        if ARKADE_UNILATERAL_CLAIM_DELAY_SECONDS == 0
            || ARKADE_UNILATERAL_REFUND_DELAY_SECONDS == 0
            || ARKADE_UNILATERAL_REFUND_WITHOUT_RECEIVER_DELAY_SECONDS == 0
        {
            anyhow::bail!(
                "ARKADE_UNILATERAL_CLAIM_DELAY_SECONDS, ARKADE_UNILATERAL_REFUND_DELAY_SECONDS and \
                 ARKADE_UNILATERAL_REFUND_WITHOUT_RECEIVER_DELAY_SECONDS must be set if PREIMAGE is defined"
            );
        }
        if hex::decode(LOCKUP_PUBKEY_COMPRESSED)?.len() != 33 {
            anyhow::bail!(
                "LOCKUP_PUBKEY_COMPRESSED must be set to a valid 33-byte compressed public key if PREIMAGE is defined"
            );
        }
        if hex::decode(LOCKUP_CLAIM_LEAF_SCRIPT)?.len() != 61 {
            anyhow::bail!(
                "LOCKUP_CLAIM_LEAF_SCRIPT must be set to a valid 61-byte tap leaf script if PREIMAGE is defined"
            );
        }
        if hex::decode(LOCKUP_REFUND_LEAF_SCRIPT)?.len() != 39 {
            anyhow::bail!(
                "LOCKUP_REFUND_LEAF_SCRIPT must be set to a valid 39-byte tap leaf script if PREIMAGE is defined"
            );
        }
    }

    println!("Setting up user identity...");
    let mnemonic: Mnemonic = ALICE_MNEMONIC.parse()?;
    let seed = mnemonic.to_seed("");
    let master_xpriv = Xpriv::new_master(network, &seed)?;
    let path = DerivationPath::from_str("m/86'/0'/0'/0/0")?;
    let child_xpriv = master_xpriv.derive_priv(&secp, &path)?;
    let user_keypair = Keypair::from_secret_key(&secp, &child_xpriv.private_key);
    let (user_xonly, _) = user_keypair.x_only_public_key();
    let user_pk_compressed = BtcPublicKey::new(user_keypair.public_key());
    println!("User public key: ['{}']", hex::encode(user_xonly.serialize()));

    let sign_fn = |input: &mut psbt::Input,
                   msg: Message|
     -> Result<Vec<(schnorr::Signature, XOnlyPublicKey)>, ark_core::Error> {
        set_condition_witness(input, preimage);
        let sig = secp.sign_schnorr_no_aux_rand(&msg, &user_keypair);
        Ok(vec![(sig, user_xonly)])
    };

    println!("Connecting to delegate...");
    let delegate_info = DelegatorClient::new(DELEGATE_URL.to_string()).info().await?;
    let delegate_xonly = SecpPublicKey::from_slice(&hex::decode(&delegate_info.pubkey)?)?
        .x_only_public_key()
        .0;
    println!("Delegate public key: ['{}']", hex::encode(delegate_xonly.serialize()));

    println!("Generating user tapscript...");
    let user_vtxo = Vtxo::new_with_delegator(
        &secp,
        operator_xonly,
        user_xonly,
        delegate_xonly,
        server_info.unilateral_exit_delay,
        network,
    )?;
    let user_address = user_vtxo.to_ark_address();
    println!("Generated user address: ['{}']", user_address.encode());

    let mut fee_rate: u64 = 1;

    if is_new_swap {
        println!("Fetching chain swap limits...");
        let limits: ChainSwapLimits = reqwest::get(format!("{BOLTZ_API}/v2/swap/chain"))
            .await?
            .json()
            .await?;
        let (min, max) = (limits.btc.ark.limits.minimal, limits.btc.ark.limits.maximal);
        println!("Fetched chain swap limits: {{min: {min}, max: {max}}}");

        if SWAP_AMOUNT < min {
            anyhow::bail!("Amount below swap minimum (amount: {SWAP_AMOUNT}, minimum: {min})");
        }
        if SWAP_AMOUNT > max {
            anyhow::bail!("Amount above swap maximum (amount: {SWAP_AMOUNT}, maximum: {max})");
        }

        println!("Fetching recommended fee rate...");
        let recommended: RecommendedFees = reqwest::get(format!("{MEMPOOL_API}/v1/fees/recommended"))
            .await?
            .json()
            .await?;
        println!("Fetched recommended fee rate: [{}]", recommended.fastest_fee);
        fee_rate = recommended.fastest_fee;
    }

    println!(
        "{}",
        if is_new_swap { "Creating chain swap..." } else { "Fetching chain swap details..." }
    );

    let client = reqwest::Client::new();
    let preimage_hash_for_request = if is_new_swap {
        sha256::Hash::hash(&preimage)
    } else {
        sha256::Hash::hash(&rand::random::<[u8; 32]>())
    };
    let response = client
        .post(format!("{BOLTZ_API}/v2/swap/chain"))
        .json(&serde_json::json!({
            "from": "BTC",
            "to": "ARK",
            "feeSatsPerByte": fee_rate,
            "claimPublicKey": hex::encode(user_pk_compressed.to_bytes()),
            "refundPublicKey": hex::encode(user_pk_compressed.to_bytes()),
            // Amount Boltz should lock on Arkade.
            "serverLockAmount": SWAP_AMOUNT,
            "preimageHash": hex::encode(preimage_hash_for_request.as_byte_array()),
        }))
        .send()
        .await?;

    if !response.status().is_success() {
        anyhow::bail!("failed to create chain swap: {}", response.text().await?);
    }

    let swap: CreateChainSwapResponse = response.json().await?;

    if swap.claim_details.amount != SWAP_AMOUNT {
        anyhow::bail!(
            "Claim amount does NOT match requested swap amount (expected: {SWAP_AMOUNT}, received: {})",
            swap.claim_details.amount
        );
    }

    // In a production scenario, all of the following should be saved from the original swap response.
    let arkade_boltz_xonly = SecpPublicKey::from_slice(&hex::decode(if is_new_swap {
        swap.claim_details.server_public_key.as_str()
    } else {
        ARKADE_BOLTZ_PUBKEY_COMPRESSED
    })?)?
    .x_only_public_key()
    .0;
    let arkade_refund_locktime: u32 = if is_new_swap {
        swap.claim_details.timeouts.refund
    } else {
        REFUND_LOCKTIME
    };
    let arkade_unilateral_claim_delay_secs = if is_new_swap {
        swap.claim_details.timeouts.unilateral_claim
    } else {
        ARKADE_UNILATERAL_CLAIM_DELAY_SECONDS
    };
    let arkade_unilateral_refund_delay_secs = if is_new_swap {
        swap.claim_details.timeouts.unilateral_refund
    } else {
        ARKADE_UNILATERAL_REFUND_DELAY_SECONDS
    };
    let arkade_unilateral_refund_without_receiver_delay_secs = if is_new_swap {
        swap.claim_details.timeouts.unilateral_refund_without_receiver
    } else {
        ARKADE_UNILATERAL_REFUND_WITHOUT_RECEIVER_DELAY_SECONDS
    };
    let arkade_unilateral_claim_delay = parse_sequence_number(arkade_unilateral_claim_delay_secs as i64)?;
    let arkade_unilateral_refund_delay = parse_sequence_number(arkade_unilateral_refund_delay_secs as i64)?;
    let arkade_unilateral_refund_without_receiver_delay =
        parse_sequence_number(arkade_unilateral_refund_without_receiver_delay_secs as i64)?;
    let mainnet_boltz_pk_compressed = BtcPublicKey::from_str(if is_new_swap {
        swap.lockup_details.server_public_key.as_str()
    } else {
        LOCKUP_PUBKEY_COMPRESSED
    })?;

    if is_new_swap {
        for leaf in [
            &swap.lockup_details.swap_tree.claim_leaf,
            &swap.lockup_details.swap_tree.refund_leaf,
        ] {
            if leaf.version != LeafVersion::TapScript.to_consensus() {
                anyhow::bail!("unsupported tapscript leaf version from Boltz: {}", leaf.version);
            }
        }
    }
    let mainnet_claim_script = ScriptBuf::from_bytes(hex::decode(if is_new_swap {
        swap.lockup_details.swap_tree.claim_leaf.output.as_str()
    } else {
        LOCKUP_CLAIM_LEAF_SCRIPT
    })?);
    let mainnet_refund_script = ScriptBuf::from_bytes(hex::decode(if is_new_swap {
        swap.lockup_details.swap_tree.refund_leaf.output.as_str()
    } else {
        LOCKUP_REFUND_LEAF_SCRIPT
    })?);
    let lockup_amount = swap.lockup_details.amount;

    /* Reconstruct claim address (Arkade) */
    println!("Reconstructing Arkade claim address...");
    let claim_vhtlc = VhtlcScript::new(
        VhtlcOptions {
            sender: arkade_boltz_xonly,
            receiver: user_xonly,
            server: operator_xonly,
            preimage_hash: ripemd160::Hash::hash(sha256::Hash::hash(&preimage).as_byte_array()),
            refund_locktime: arkade_refund_locktime,
            unilateral_claim_delay: arkade_unilateral_claim_delay,
            unilateral_refund_delay: arkade_unilateral_refund_delay,
            unilateral_refund_without_receiver_delay: arkade_unilateral_refund_without_receiver_delay,
        },
        network,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    let claim_address = claim_vhtlc.address();

    /* Reconstruct lockup address (mainnet) */
    println!("Reconstructing mainnet lockup address...");
    let lockup_address = reconstruct_mainnet_lockup_address(
        mainnet_boltz_pk_compressed,
        user_pk_compressed,
        mainnet_claim_script.clone(),
        mainnet_refund_script.clone(),
        network,
    )?;

    if is_new_swap {
        /* Ensure claim address matches */
        println!("Validating Arkade claim address...");
        if claim_address.encode() != swap.claim_details.lockup_address {
            anyhow::bail!(
                "Derived Arkade claim address does NOT match API response (expected: {}, received: {})",
                claim_address.encode(),
                swap.claim_details.lockup_address
            );
        }
        println!("Validated Arkade claim address: ['{}']", claim_address.encode());
        /* Ensure lockup address matches */
        println!("Validating mainnet lockup address...");
        if lockup_address.to_string() != swap.lockup_details.lockup_address {
            anyhow::bail!(
                "Derived mainnet lockup address does NOT match API response (expected: {}, received: {})",
                lockup_address,
                swap.lockup_details.lockup_address
            );
        }
        println!("Validated mainnet lockup address: ['{lockup_address}']");

        anyhow::bail!(
            "\n\
             \u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\n\
             \u{1F6A8}   PREIMAGE, REFUND_LOCKTIME, ARKADE_BOLTZ_PUBKEY_COMPRESSED,      \u{1F6A8}\n\
             \u{1F6A8}   ARKADE_UNILATERAL_*_DELAY_SECONDS, LOCKUP_PUBKEY_COMPRESSED,    \u{1F6A8}\n\
             \u{1F6A8}   LOCKUP_CLAIM_LEAF_SCRIPT and LOCKUP_REFUND_LEAF_SCRIPT          \u{1F6A8}\n\
             \u{1F6A8}                        are not defined!                          \u{1F6A8}\n\
             \u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\u{1F6A8}\n\
             lockupAmount: {lockup_amount}\n\
             lockupAddress: {lockup_address}\n\
             expectedClaimAmount: {SWAP_AMOUNT}\n\
             claimAddress: {claim_address}\n\
             PREIMAGE: {}\n\
             REFUND_LOCKTIME: {arkade_refund_locktime}\n\
             ARKADE_BOLTZ_PUBKEY_COMPRESSED: {}\n\
             ARKADE_UNILATERAL_CLAIM_DELAY_SECONDS: {arkade_unilateral_claim_delay_secs}\n\
             ARKADE_UNILATERAL_REFUND_DELAY_SECONDS: {arkade_unilateral_refund_delay_secs}\n\
             ARKADE_UNILATERAL_REFUND_WITHOUT_RECEIVER_DELAY_SECONDS: {arkade_unilateral_refund_without_receiver_delay_secs}\n\
             LOCKUP_PUBKEY_COMPRESSED: {}\n\
             LOCKUP_CLAIM_LEAF_SCRIPT: {}\n\
             LOCKUP_REFUND_LEAF_SCRIPT: {}",
            hex::encode(preimage),
            swap.claim_details.server_public_key,
            hex::encode(mainnet_boltz_pk_compressed.to_bytes()),
            hex::encode(mainnet_claim_script.as_bytes()),
            hex::encode(mainnet_refund_script.as_bytes()),
        );
    }

    println!(
        "Fetched chain swap: {{lockupAmount: {lockup_amount}, lockupAddress: {lockup_address}, expectedClaimAmount: {SWAP_AMOUNT}, claimAddress: {}}}",
        claim_address.encode()
    );

    println!("Connecting to indexer...");
    println!("Fetching inputs for claim address...");
    let vtxos_response = operator
        .list_vtxos(
            GetVtxosRequest::new_for_addresses(std::iter::once(claim_address))
                .spendable_only()
                .map_err(|e| anyhow::anyhow!("{e}"))?,
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    // Filter out inputs with Arkade assets.
    let inputs: Vec<_> = vtxos_response
        .vtxos
        .into_iter()
        .filter(|input| input.assets.is_empty())
        .collect();
    let input_total: u64 = inputs.iter().map(|v| v.amount.to_sat()).sum();
    println!("Contract balance: [{input_total}]");

    if input_total == 0 {
        anyhow::bail!("Claim address not funded (address: {})", claim_address.encode());
    }

    println!("Generating claim transaction...");
    let script_ver = (claim_vhtlc.claim_script(), LeafVersion::TapScript);
    let control_block = claim_vhtlc
        .taproot_spend_info()
        .control_block(&script_ver)
        .ok_or_else(|| anyhow::anyhow!("control block not found for claim script"))?;
    let script_pubkey = claim_vhtlc.script_pubkey();
    // `tapscripts()` consumes the VhtlcScript, so it must be the last thing we call on it.
    let tapscripts = claim_vhtlc.tapscripts();

    let vtxo_inputs: Vec<VtxoInput> = inputs
        .iter()
        .map(|vtxo| {
            VtxoInput::new(
                script_ver.0.clone(),
                None,
                control_block.clone(),
                tapscripts.clone(),
                script_pubkey.clone(),
                vtxo.amount,
                vtxo.outpoint,
                vtxo.assets.clone(),
            )
        })
        .collect();

    // Sweep all to self.
    let receivers = vec![SendReceiver::bitcoin(user_address.clone(), Amount::from_sat(input_total))];

    let mut offchain_txs = build_offchain_transactions(&receivers, &user_address, &vtxo_inputs, &server_info)
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let ark_tx_b64 = STANDARD.encode(offchain_txs.ark_tx.serialize());
    println!("Generated Arkade transaction: ['{ark_tx_b64}']");
    let checkpoint_b64s: Vec<String> = offchain_txs
        .checkpoint_txs
        .iter()
        .map(|tx| STANDARD.encode(tx.serialize()))
        .collect();
    println!("Generated unsigned checkpoint transactions: {checkpoint_b64s:?}");

    println!("Signing...");
    for i in 0..offchain_txs.ark_tx.inputs.len() {
        sign_ark_transaction(sign_fn, &mut offchain_txs.ark_tx, i).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    let signed_ark_tx_b64 = STANDARD.encode(offchain_txs.ark_tx.serialize());
    println!("Signed Arkade transaction: ['{signed_ark_tx_b64}']");

    println!("Submitting Arkade transaction with unsigned checkpoint transactions to operator...");
    let response = operator
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
        println!("Finalizing checkpoint transaction...");
        sign_checkpoint_transaction(sign_fn, &mut checkpoint_psbt).map_err(|e| anyhow::anyhow!("{e}"))?;
        finalized_checkpoints.push(checkpoint_psbt);
    }
    let finalized_b64s: Vec<String> = finalized_checkpoints
        .iter()
        .map(|tx| STANDARD.encode(tx.serialize()))
        .collect();
    println!("Finalized checkpoint transactions: {finalized_b64s:?}");

    let txid = response.signed_ark_tx.unsigned_tx.compute_txid();

    println!("Finalizing transaction...");
    operator
        .finalize_offchain_transaction(txid, finalized_checkpoints)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    println!("Broadcasted! https://explorer.mutinynet.arkade.sh/tx/{txid}");

    Ok(())
}
