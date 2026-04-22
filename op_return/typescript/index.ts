import {
  ArkAddress,
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
import { OutScript, Script } from '@scure/btc-signer';
import { base64, hex, utf8 } from '@scure/base';

const ALICE_SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

console.log('Connecting to operator...')
const arkProvider = new RestArkProvider('https://arkade.computer');
const providerInfo = await arkProvider.getInfo();

console.log('Setting up operator identity...')
const operatorIdentity = ReadonlySingleKey.fromPublicKey(hex.decode(providerInfo.signerPubkey))
const operatorPubkey = await operatorIdentity.xOnlyPublicKey();

console.log('Setting up Alice identity...')
const aliceIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED, {});
const alicePubkey = await aliceIdentity.xOnlyPublicKey()

console.log('Constructing simple address with collaborative spend path...')
const collaborativePath = MultisigTapscript.encode({
  pubkeys: [operatorPubkey, alicePubkey],
}).script
const vtxoScript = new VtxoScript([collaborativePath]);
console.log('Address:', vtxoScript.address(networks.bitcoin.hrp, operatorPubkey).encode())

console.log('Connecting to indexer...')
const indexerProvider = new RestIndexerProvider('https://arkade.computer')

console.log('Checking spendable balance in address...')
const vtxos = (await indexerProvider.getVtxos({
  scripts: [hex.encode(vtxoScript.pkScript)],
  spendableOnly: true,
})).vtxos
const balance = vtxos.reduce(
  (total, current) => total + BigInt(current.value),
  0n,
);
console.log('Spendable balance:', balance)

if (balance > 0n) {
  console.log('Generating transaction...')
  const { arkTx: tx, checkpoints: checkpointTxs } = buildOffchainTx(
    // Map VTXOs into PSBT inputs
    vtxos.map(({ txid, vout, value }) => ({
      txid,
      vout,
      value,
      tapLeafScript: vtxoScript.findLeaf(hex.encode(collaborativePath)),
      tapTree: vtxoScript.encode(),
    })),
    [
      // Create a subdust output of 1 satoshi
      {
        amount: 1n,
        script: Script.encode(["RETURN", vtxoScript.tweakedPublicKey])
      },
      // Create an OP_RETURN output
      {
        amount: 0n,
        script: Script.encode(["RETURN", utf8.decode('hello world!')])
      },
      // Sweep remaining balance to self
      {
        amount: balance - 1n,
        script: vtxoScript.pkScript
      },
    ],
    // Unroll script (mandatory)
    CSVMultisigTapscript.decode(
      hex.decode(providerInfo.checkpointTapscript)
    ));

  console.log('Generated Arkade transaction:', [base64.encode(tx.toPSBT())])
  console.log('Generated unsigned checkpoints:', checkpointTxs.map(tx => base64.encode(tx.toPSBT())))

  let signedTx = tx;
  console.log('Signing with Alice...')
  signedTx = await aliceIdentity.sign(signedTx)
  console.log('Signed Arkade transaction:', [base64.encode(signedTx.toPSBT())])

  console.log('Submitting Arkade transaction with unsigned checkpoint PSBTs to operator...')
  const { arkTxid: txid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signedTx.toPSBT()),
    checkpointTxs.map((checkpointTx) => base64.encode(checkpointTx.toPSBT()))
  );
  console.log('Received signed checkpoint transactions:', signedCheckpointTxs)

  console.log('Finalizing signed checkpoint transactions...')
  const finalizedCheckpointTxs = await Promise.all(
    signedCheckpointTxs.map(async (signedCheckpointTx) => {
      let finalizedCheckpointTx = Transaction.fromPSBT(base64.decode(signedCheckpointTx));
      console.log('Finalizing checkpoint transaction with Alice...')
      finalizedCheckpointTx = await aliceIdentity.sign(finalizedCheckpointTx);
      return base64.encode(finalizedCheckpointTx.toPSBT());
    })
  );
  console.log('Finalized checkpoint transactions:', finalizedCheckpointTxs)

  console.log('Finalizing transaction...')
  await arkProvider.finalizeTx(txid, finalizedCheckpointTxs);

  console.log('Broadcasted!', `https://arkade.space/tx/${txid}`)

  console.log('Sleeping for 3 seconds...')
  await new Promise(resolve => setTimeout(resolve, 3000))

  console.log('Fetching transaction outputs...')
  const txs = (await indexerProvider.getVirtualTxs([txid])).txs
  if (!txs.length) {
    console.error(`Could not find transaction`)
  } else {
    const tx = Transaction.fromPSBT(base64.decode(txs[0]))
    for (let vout = 0; vout < tx.outputsLength; vout++) {
      const output = tx.getOutput(vout);
      const amount = output.amount ?? 0n;
      const outScript = output.script && OutScript.decode(output.script);
      if (outScript?.type === 'p2a') {
        console.log(`Found anchor output at index #${vout} with amount ${amount}`)
        continue
      }
      if (outScript && "pubkey" in outScript) {
        console.log(`Found standard payment at index #${vout} with amount ${amount}`, [(new ArkAddress(operatorPubkey, outScript.pubkey, 'ark')).encode()])
        continue
      }
      const script = output.script && Script.decode(output.script)
      if (script?.[0] === 'RETURN' && script?.[1] instanceof Uint8Array) {
        const bytes = script[1];
        if (bytes.length === 32) {
          console.log(`Found subdust payment at index #${vout} with amount ${amount}`, [(new ArkAddress(operatorPubkey, bytes, 'ark')).encode()])
          continue
        } else {
          console.log(`Found op_return output at index #${vout} with amount ${amount}`, [utf8.encode(bytes)])
          continue
        }
      }
      console.error(`Could not decode output at index #${vout} with amount ${amount}`, output)
    }
  }
}