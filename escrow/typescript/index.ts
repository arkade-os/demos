import {
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  MnemonicIdentity,
  MultisigTapscript,
  ReadonlySingleKey,
  RestArkProvider,
  RestIndexerProvider,
  Transaction,
  VtxoScript,
  buildOffchainTx,
  networks,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base';

// Can co-sign a payout/refund with either player, or sweep after a timeout
const ARBITER_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ARBITER_PATHS = [0, 1, 2];

// Can co-sign a payout/refund with the arbiter, or collaborate with player B to exit (with or without server)
const ALICE_SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ALICE_PATHS = [0, 3, 4];

// Can co-sign a payout/refund with the arbiter, or collaborate with player A to exit (with or without server)
const BOB_SEED = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const BOB_PATHS = [1, 3, 4]

// Helper for generating escrow script
const generateEscrowScript = async (
  operator: Uint8Array<ArrayBufferLike>,
  arbiter: Uint8Array<ArrayBufferLike>,
  playerA: Uint8Array<ArrayBufferLike>,
  playerB: Uint8Array<ArrayBufferLike>,
  expiry: bigint = BigInt(Math.floor(Date.now() / 1000)) + (60n * 60n * 24n) // 24 hours from now
): Promise<[
  expiry: bigint,
  address: string,
  pkScript: VtxoScript["pkScript"],
  tapTree: ReturnType<VtxoScript["encode"]>,
  tapLeafScripts: Array<ReturnType<VtxoScript["findLeaf"]>>,
]> => {
  const paths = [
    // Path 0: Player A paid out (wins wager or refunded)
    MultisigTapscript.encode({
      pubkeys: [operator, arbiter, playerA]
    }).script,
    // Path 1: Player B paid out (wins wager or refunded)
    MultisigTapscript.encode({
      pubkeys: [operator, arbiter, playerB]
    }).script,
    // Path 2: Arbiter can sweep after timeout
    CLTVMultisigTapscript.encode({
      pubkeys: [operator, arbiter],
      absoluteTimelock: expiry
    }).script,
    // Path 3: Players collaborate without arbiter
    MultisigTapscript.encode({
      pubkeys: [operator, playerA, playerB]
    }).script,
    // Path 4: Players collaborate without arbiter or server (unilateral exit)
    CSVMultisigTapscript.encode({
      pubkeys: [playerA, playerB],
      timelock: {
        value: providerInfo.unilateralExitDelay,
        type: 'seconds'
      }
    }).script,
  ]
  const escrowScript = new VtxoScript(paths);
  const tapLeafScripts = paths.map(path => escrowScript.findLeaf(hex.encode(path)))
  return [
    expiry,
    escrowScript.address(networks.bitcoin.hrp, operator).encode(),
    escrowScript.pkScript,
    escrowScript.encode(),
    tapLeafScripts
  ]
}

console.log('Connecting to operator...')
const arkProvider = new RestArkProvider('https://arkade.computer');
const providerInfo = await arkProvider.getInfo();

console.log('Setting up operator identity...')
const operatorIdentity = ReadonlySingleKey.fromPublicKey(hex.decode(providerInfo.signerPubkey))
const operatorPubkey = await operatorIdentity.xOnlyPublicKey();

console.log('Setting up arbiter identity...')
const arbiterIdentity = MnemonicIdentity.fromMnemonic(ARBITER_SEED, {});
const arbiterPubkey = await arbiterIdentity.xOnlyPublicKey();

console.log('Setting up Alice identity...')
const aliceIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED, {});
const alicePubkey = await aliceIdentity.xOnlyPublicKey()

console.log('Setting up Bob identity...')
const bobIdentity = MnemonicIdentity.fromMnemonic(BOB_SEED, {});
const bobPubkey = await bobIdentity.xOnlyPublicKey()

console.log('Generating escrow address...')
const [expiry, address, pkScript, tapTree, tapLeafScripts] = await generateEscrowScript(
  operatorPubkey,
  arbiterPubkey,
  alicePubkey,
  bobPubkey,
  1750000000n // June 2025 (i.e., already spendable)
)
console.log('Generated address:', address)
console.log('Expiry (absolute timelock):', expiry)

console.log('Connecting to indexer...')
const indexerProvider = new RestIndexerProvider('https://arkade.computer')

console.log('Checking spendable balance in escrow address...')
const vtxos = (await indexerProvider.getVtxos({
  scripts: [hex.encode(pkScript)],
  spendableOnly: true,
})).vtxos
const balance = vtxos.reduce(
  (total, current) => total + BigInt(current.value),
  0n,
);
console.log('Spendable balance:', balance)

// Dynamically decide which path to take based on the final digit of the balance
// (e.g. 330 = path 0, 332 = path 2)
if (balance > 0) {
  const tapLeafIndex = +balance.toString().slice(-1) % tapLeafScripts.length; // anything ending in a number over 4 will default to path #0
  const arbiterRequired = ARBITER_PATHS.includes(tapLeafIndex);
  const aliceRequired = ALICE_PATHS.includes(tapLeafIndex);
  const bobRequired = BOB_PATHS.includes(tapLeafIndex);
  console.log(`Choosing path #${tapLeafIndex}`, {
    arbiterRequired, aliceRequired, bobRequired
  })

  if (tapLeafIndex === 4) {
    throw new Error('Unilateral exit logic not implemented in this example yet, see https://arkade-os.github.io/ts-sdk/#unilateral-exit')
  }

  console.log('Generating transaction...')
  const { arkTx: tx, checkpoints: checkpointTxs } = buildOffchainTx(
    // Map VTXOs into PSBT inputs
    vtxos.map(vtxo => ({
      txid: vtxo.txid,
      vout: vtxo.vout,
      value: vtxo.value,
      tapLeafScript: tapLeafScripts[tapLeafIndex],
      tapTree,
    })),
    // Sweep everything to self
    [{
      amount: balance,
      script: pkScript
    }],
    // Unroll script (mandatory)
    CSVMultisigTapscript.decode(
      hex.decode(providerInfo.checkpointTapscript)
    ));

  console.log('Generated Arkade transaction:', [base64.encode(tx.toPSBT())])
  console.log('Generated unsigned checkpoint transactions:', checkpointTxs.map(tx => base64.encode(tx.toPSBT())))

  let signedTx = tx;
  if (arbiterRequired) {
    console.log('Signing with arbiter...')
    signedTx = await arbiterIdentity.sign(signedTx)
  }
  if (aliceRequired) {
    console.log('Signing with Alice...')
    signedTx = await aliceIdentity.sign(signedTx)
  }
  if (bobRequired) {
    console.log('Signing with Bob...')
    signedTx = await bobIdentity.sign(signedTx)
  }
  console.log('Signed Arkade transaction:', [base64.encode(signedTx.toPSBT())])

  console.log('Submitting Arkade transaction with unsigned checkpoint transactions to operator...')
  const { arkTxid: txid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signedTx.toPSBT()),
    checkpointTxs.map((checkpointTx) => base64.encode(checkpointTx.toPSBT()))
  );
  console.log('Received signed checkpoint transactions:', signedCheckpointTxs)

  console.log('Finalizing signed checkpoint transactions...')
  const finalizedCheckpointTxs = await Promise.all(
    signedCheckpointTxs.map(async (signedCheckpointTx) => {
      let finalizedCheckpointTx = Transaction.fromPSBT(base64.decode(signedCheckpointTx));
      if (arbiterRequired) {
        console.log('Finalizing checkpoint transaction with arbiter...')
        finalizedCheckpointTx = await arbiterIdentity.sign(finalizedCheckpointTx);
      }
      if (aliceRequired) {
        console.log('Finalizing checkpoint transaction with Alice...')
        finalizedCheckpointTx = await aliceIdentity.sign(finalizedCheckpointTx);
      }
      if (bobRequired) {
        console.log('Finalizing checkpoint transaction with Bob...')
        finalizedCheckpointTx = await bobIdentity.sign(finalizedCheckpointTx);
      }
      return base64.encode(finalizedCheckpointTx.toPSBT());
    })
  );
  console.log('Finalized checkpoint transactions:', finalizedCheckpointTxs)

  console.log('Finalizing transaction...')
  await arkProvider.finalizeTx(txid, finalizedCheckpointTxs);

  console.log('Broadcasted!', `https://arkade.space/tx/${txid}`)
}