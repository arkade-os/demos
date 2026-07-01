import { RestIndexerProvider, Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

const TXID =
  "70571e9542ce81c1e23ab6eb3dfb7dafb050171ae1d632e75a093cf445b8d786" as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider();

/** 2. Fetch transaction */
const { txs } = await indexer.getVirtualTxs([TXID]);

/** 3. Log virtual transactions (map to basic details) */
for (const psbt of txs) {
  const tx = Transaction.fromPSBT(base64.decode(psbt));
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    console.log(`input #${i}:`, {
      txid: hex.encode(input.txid!),
      vout: input.index!,
      value: input.witnessUtxo?.amount,
    });
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i);
    console.log(`output #${i}:`, {
      script: hex.encode(output.script!),
      value: output.amount,
    });
  }
}
