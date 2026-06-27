use ark_core::script::{multisig_3_of_3_script, tr_script_pubkey};
use ark_core::send::{
    build_offchain_transactions, sign_ark_transaction, sign_checkpoint_transaction, SendReceiver,
    VtxoInput,
};
use ark_core::server::GetVtxosRequest;
use ark_core::{ArkAddress, UNSPENDABLE_KEY};
use ark_rest::Client;
use bip39::Mnemonic;
use bitcoin::base64::{engine::general_purpose::STANDARD, Engine};
use bitcoin::key::{Keypair, PublicKey, Secp256k1};
use bitcoin::opcodes::all::{OP_CHECKSIG, OP_CHECKSIGVERIFY, OP_CLTV, OP_CSV, OP_DROP};
use bitcoin::script::Builder;
use bitcoin::taproot::{LeafVersion, TaprootBuilder};
use bitcoin::{
    absolute::LockTime,
    bip32::{DerivationPath, Xpriv},
    Amount, ScriptBuf, XOnlyPublicKey,
};
use std::str::FromStr;

// Can co-sign a payout/refund with either player, or sweep after a timeout
const ARBITER_MNEMONIC: &str =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";

// Can co-sign a payout/refund with the arbiter, or collaborate with player B to exit (with or without server)
const ALICE_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Can co-sign a payout/refund with the arbiter, or collaborate with player A to exit (with or without server)
const BOB_MNEMONIC: &str = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

const ARK_SERVER_URL: &str = "https://arkade.computer";

// Path 2: CLTV 2-of-2 multisig (arbiter timeout sweep)
fn cltv_multisig_script(expiry: LockTime, pk_0: XOnlyPublicKey, pk_1: XOnlyPublicKey) -> ScriptBuf {
    // <expiry> OP_CLTV OP_DROP <pk_0> OP_CHECKSIGVERIFY <pk_1> OP_CHECKSIG
    Builder::new()
        .push_int(expiry.to_consensus_u32() as i64)
        .push_opcode(OP_CLTV)
        .push_opcode(OP_DROP)
        .push_x_only_key(&pk_0)
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_x_only_key(&pk_1)
        .push_opcode(OP_CHECKSIG)
        .into_script()
}

// Path 4: CSV 2-of-2 multisig (unilateral player exit, no server)
fn csv_multisig_script(
    locktime: bitcoin::Sequence,
    pk_0: XOnlyPublicKey,
    pk_1: XOnlyPublicKey,
) -> ScriptBuf {
    // <locktime> OP_CSV OP_DROP <pk_0> OP_CHECKSIGVERIFY <pk_1> OP_CHECKSIG
    Builder::new()
        .push_int(locktime.to_consensus_u32() as i64)
        .push_opcode(OP_CSV)
        .push_opcode(OP_DROP)
        .push_x_only_key(&pk_0)
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_x_only_key(&pk_1)
        .push_opcode(OP_CHECKSIG)
        .into_script()
}

fn derive_xonly(
    mnemonic: &str,
    secp: &Secp256k1<bitcoin::secp256k1::All>,
    network: bitcoin::Network,
) -> anyhow::Result<(XOnlyPublicKey, Keypair)> {
    let mnemonic: Mnemonic = mnemonic.parse()?;
    let seed = mnemonic.to_seed("");
    let master = Xpriv::new_master(network, &seed)?;
    let path = DerivationPath::from_str("m/86'/0'/0'/0/0")?;
    let child = master.derive_priv(secp, &path)?;
    let keypair = Keypair::from_secret_key(secp, &child.private_key);
    let (xonly, _) = keypair.x_only_public_key();
    Ok((xonly, keypair))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let secp = Secp256k1::new();

    println!("Connecting to operator...");
    let client = Client::new(ARK_SERVER_URL.to_string())?;
    let server_info = client.get_info().await?;
    let network = server_info.network;

    println!("Setting up operator identity...");
    let server_xonly = server_info.signer_pk.x_only_public_key().0;

    println!("Setting up arbiter identity...");
    let (arbiter_xonly, arbiter_kp) = derive_xonly(ARBITER_MNEMONIC, &secp, network)?;

    println!("Setting up Alice identity...");
    let (alice_xonly, alice_kp) = derive_xonly(ALICE_MNEMONIC, &secp, network)?;

    println!("Setting up Bob identity...");
    let (bob_xonly, bob_kp) = derive_xonly(BOB_MNEMONIC, &secp, network)?;

    println!("Generating escrow address...");
    // June 2025 Unix timestamp (already in the past — CLTV path is immediately spendable)
    let expiry = LockTime::from_consensus(1750000000u32);

    let scripts: Vec<ScriptBuf> = vec![
        // Path 0: Player A paid out (wins wager or refunded)
        multisig_3_of_3_script(server_xonly, arbiter_xonly, alice_xonly),
        // Path 1: Player B paid out (wins wager or refunded)
        multisig_3_of_3_script(server_xonly, arbiter_xonly, bob_xonly),
        // Path 2: Arbiter can sweep after timeout
        cltv_multisig_script(expiry, server_xonly, arbiter_xonly),
        // Path 3: Players collaborate without arbiter
        multisig_3_of_3_script(server_xonly, alice_xonly, bob_xonly),
        // Path 4: Players collaborate without arbiter or server (unilateral exit)
        csv_multisig_script(server_info.unilateral_exit_delay, alice_xonly, bob_xonly),
    ];

    // Build TaprootSpendInfo matching the TypeScript VtxoScript tree layout.
    let unspendable_key: PublicKey = UNSPENDABLE_KEY.parse()?;
    let (unspendable_xonly, _) = unspendable_key.inner.x_only_public_key();

    let ordered: [(u8, &ScriptBuf); 5] = [
        (3, &scripts[3]), // path3: players without arbiter
        (3, &scripts[2]), // path2: CLTV arbiter sweep
        (2, &scripts[4]), // path4: unilateral exit
        (2, &scripts[1]), // path1: player B paid out
        (2, &scripts[0]), // path0: player A paid out
    ];
    let mut builder = TaprootBuilder::new();
    for (depth, script) in ordered.iter() {
        builder = builder
            .add_leaf(*depth, (*script).clone())
            .map_err(|e| anyhow::anyhow!("add_leaf error: {e}"))?;
    }
    let spend_info = builder
        .finalize(&secp, unspendable_xonly)
        .map_err(|_| anyhow::anyhow!("failed to finalize taproot tree"))?;

    let script_pubkey = tr_script_pubkey(&spend_info);
    let address = ArkAddress::new(network, server_xonly, spend_info.output_key());

    println!("Generated address: {}", address.encode());
    println!("Expiry (absolute timelock): {}", expiry.to_consensus_u32());

    println!("Connecting to indexer...");
    println!("Checking spendable balance in escrow address...");

    let vtxos_response = client
        .list_vtxos(
            GetVtxosRequest::new_for_addresses(std::iter::once(address))
                .spendable_only()
                .map_err(|e| anyhow::anyhow!("{e}"))?,
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let vtxos = vtxos_response.vtxos;
    let balance: u64 = vtxos.iter().map(|v| v.amount.to_sat()).sum();
    println!("Spendable balance: {balance}");

    // Dynamically decide which path to take based on the final digit of the balance
    if balance > 0 {
        let tap_leaf_index = (balance % 10) as usize % scripts.len(); // anything ending in a number over 4 will default to path #0
        let arbiter_required = [0usize, 1, 2].contains(&tap_leaf_index);
        let alice_required = [0usize, 3, 4].contains(&tap_leaf_index);
        let bob_required = [1usize, 3, 4].contains(&tap_leaf_index);
        println!(
            "Choosing path #{tap_leaf_index} (arbiterRequired: {arbiter_required}, aliceRequired: {alice_required}, bobRequired: {bob_required})"
        );

        if tap_leaf_index == 4 {
            anyhow::bail!(
                "Unilateral exit logic not implemented in this example yet, see https://arkade-os.github.io/ts-sdk/#unilateral-exit"
            );
        }

        // Set CLTV locktime for path 2; all other paths use None
        let locktime = if tap_leaf_index == 2 {
            Some(LockTime::from_consensus(expiry.to_consensus_u32()))
        } else {
            None
        };

        // Build VtxoInputs using the chosen spend script
        let spend_script = scripts[tap_leaf_index].clone();
        let control_block = spend_info
            .control_block(&(spend_script.clone(), LeafVersion::TapScript))
            .ok_or_else(|| anyhow::anyhow!("control block not found for path {tap_leaf_index}"))?;

        let vtxo_inputs: Vec<VtxoInput> = vtxos
            .iter()
            .map(|vtxo| {
                VtxoInput::new(
                    spend_script.clone(),
                    locktime,
                    control_block.clone(),
                    scripts.clone(),
                    script_pubkey.clone(),
                    vtxo.amount,
                    vtxo.outpoint,
                    vec![],
                )
            })
            .collect();

        // Sweep everything to self (escrow address)
        let receivers = vec![SendReceiver::bitcoin(address, Amount::from_sat(balance))];

        println!("Generating transaction...");
        let mut offchain_txs =
            build_offchain_transactions(&receivers, &address, &vtxo_inputs, &server_info)
                .map_err(|e| anyhow::anyhow!("{e}"))?;

        let ark_tx_b64 = STANDARD.encode(offchain_txs.ark_tx.serialize());
        println!("Generated Arkade transaction: ['{ark_tx_b64}']");
        let checkpoint_b64s: Vec<String> = offchain_txs
            .checkpoint_txs
            .iter()
            .map(|tx| STANDARD.encode(tx.serialize()))
            .collect();
        println!("Generated unsigned checkpoint transactions: {checkpoint_b64s:?}");

        // Sign with each required party
        for i in 0..offchain_txs.ark_tx.inputs.len() {
            if arbiter_required {
                println!("Signing with arbiter...");
                let kp = arbiter_kp.clone();
                let (xonly, _) = kp.x_only_public_key();
                sign_ark_transaction(
                    |_, msg| Ok(vec![(secp.sign_schnorr_no_aux_rand(&msg, &kp), xonly)]),
                    &mut offchain_txs.ark_tx,
                    i,
                )
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            if alice_required {
                println!("Signing with Alice...");
                let kp = alice_kp.clone();
                let (xonly, _) = kp.x_only_public_key();
                sign_ark_transaction(
                    |_, msg| Ok(vec![(secp.sign_schnorr_no_aux_rand(&msg, &kp), xonly)]),
                    &mut offchain_txs.ark_tx,
                    i,
                )
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            if bob_required {
                println!("Signing with Bob...");
                let kp = bob_kp.clone();
                let (xonly, _) = kp.x_only_public_key();
                sign_ark_transaction(
                    |_, msg| Ok(vec![(secp.sign_schnorr_no_aux_rand(&msg, &kp), xonly)]),
                    &mut offchain_txs.ark_tx,
                    i,
                )
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
        }

        let signed_ark_tx_b64 = STANDARD.encode(offchain_txs.ark_tx.serialize());
        println!("Signed Arkade transaction: ['{signed_ark_tx_b64}']");

        println!(
            "Submitting Arkade transaction with unsigned checkpoint transactions to operator..."
        );
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
            if arbiter_required {
                println!("Finalizing checkpoint transaction with arbiter...");
                let kp = arbiter_kp.clone();
                let (xonly, _) = kp.x_only_public_key();
                sign_checkpoint_transaction(
                    |_, msg| Ok(vec![(secp.sign_schnorr_no_aux_rand(&msg, &kp), xonly)]),
                    &mut checkpoint_psbt,
                )
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            if alice_required {
                println!("Finalizing checkpoint transaction with Alice...");
                let kp = alice_kp.clone();
                let (xonly, _) = kp.x_only_public_key();
                sign_checkpoint_transaction(
                    |_, msg| Ok(vec![(secp.sign_schnorr_no_aux_rand(&msg, &kp), xonly)]),
                    &mut checkpoint_psbt,
                )
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            if bob_required {
                println!("Finalizing checkpoint transaction with Bob...");
                let kp = bob_kp.clone();
                let (xonly, _) = kp.x_only_public_key();
                sign_checkpoint_transaction(
                    |_, msg| Ok(vec![(secp.sign_schnorr_no_aux_rand(&msg, &kp), xonly)]),
                    &mut checkpoint_psbt,
                )
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
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
    }

    Ok(())
}
