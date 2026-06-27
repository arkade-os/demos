import {
  buildOffchainTx,
  CSVMultisigTapscript,
  DelegateVtxo,
  Intent,
  MnemonicIdentity,
  networks,
  ReadonlySingleKey,
  RestArkProvider,
  RestDelegateProvider,
  RestIndexerProvider,
  type SignedIntent,
  Transaction,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

const ALICE_SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const NETWORK = networks.mutinynet;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

console.log("Setting up user identity...");
const userIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED, {
  isMainnet: false,
});
const userPubkey = await userIdentity.xOnlyPublicKey();
console.log("User public key:", [hex.encode(userPubkey)]);

console.log("Connecting to Arkade operator...");
const operator = new RestArkProvider(OPERATOR_URL);
const operatorInfo = await operator.getInfo();
const operatorPubkey = await ReadonlySingleKey.fromPublicKey(
  hex.decode(operatorInfo.signerPubkey),
).xOnlyPublicKey();
const exitTimelock = {
  value: operatorInfo.unilateralExitDelay,
  type: "seconds",
} as const;
const checkpointTapscript = CSVMultisigTapscript.decode(
  hex.decode(operatorInfo.checkpointTapscript),
);
console.log("Operator public key:", [hex.encode(operatorPubkey)]);

console.log("Connecting to delegate...");
const delegate = new RestDelegateProvider(DELEGATE_URL);
const delegateInfo = await delegate.getDelegateInfo();
const delegatePubkey = await ReadonlySingleKey.fromPublicKey(
  hex.decode(delegateInfo.pubkey),
).xOnlyPublicKey();
console.log("Delegate public key:", [hex.encode(delegatePubkey)]);

console.log("Generating user tapscript...");
const userScript = new DelegateVtxo.Script({
  pubKey: userPubkey,
  serverPubKey: operatorPubkey,
  delegatePubKey: delegatePubkey,
  csvTimelock: exitTimelock,
});
const userAddress = userScript.address(NETWORK.hrp, operatorPubkey);
console.log("Generated user address:", [userAddress.encode()]);

console.log("Connecting to indexer...");
const indexer = new RestIndexerProvider(OPERATOR_URL);

console.log("Fetching inputs for user address...");
const [hasSpendableBalance, inputs] = await indexer
  .getVtxos({
    scripts: [hex.encode(userAddress.pkScript)],
  })
  .then(({ vtxos }) =>
    vtxos
      /** Filter out inputs with Arkade assets */
      .filter((input) => !input.assets?.length),
  )
  .then((inputs) => {
    const spendable = inputs.filter((input) =>
      ["preconfirmed", "settled"].includes(input.virtualStatus.state),
    );
    /** If any funds are not spent in a pending transaction, return only those */
    if (spendable.some((input) => !input.isSpent)) {
      return [true, spendable.filter((input) => !input.isSpent)] as const;
    }
    /** Else, return inputs that are spent, but not finalized */
    return [false, inputs.filter((input) => input.isSpent)] as const;
  });

const inputTotal = inputs.reduce((sum, input) => sum + BigInt(input.value), 0n);
if (hasSpendableBalance) {
  console.log("Spendable balance:", [inputTotal]);
} else if (inputTotal === 0n) {
  throw new Error(`User address not funded`, {
    cause: {
      address: userAddress.encode(),
    },
  });
}

if (hasSpendableBalance) {
  console.log("Generating transaction...");
  const { arkTx: tx, checkpoints: checkpointTxs } = buildOffchainTx(
    inputs.map(({ txid, vout, value }) => ({
      txid,
      vout,
      value,
      /** Make input spendable */
      tapLeafScript: userScript.forfeit(),
      tapTree: userScript.encode(),
    })),
    [
      /** Sweep all to self */
      {
        script: userAddress.pkScript,
        amount: inputTotal,
      },
    ],
    /** Unroll script (mandatory) */
    checkpointTapscript,
  );
  console.log("Generated transaction:", [base64.encode(tx.toPSBT())]);
  console.log(
    "Generated unsigned checkpoint transactions:",
    checkpointTxs.map((tx) => base64.encode(tx.toPSBT())),
  );

  console.log("Signing...");
  const signedTx = await userIdentity.sign(tx);
  console.log("Signed Arkade transaction:", [base64.encode(signedTx.toPSBT())]);

  console.log(
    "Submitting Arkade transaction with unsigned checkpoint transactions to operator...",
  );
  const { arkTxid: txid, signedCheckpointTxs } = await operator.submitTx(
    base64.encode(signedTx.toPSBT()),
    checkpointTxs.map((checkpointTx) => base64.encode(checkpointTx.toPSBT())),
  );
  console.log("Received signed checkpoint transactions:", signedCheckpointTxs);

  throw new Error(
    "Intentionally stopping, run again to resume pending transaction",
    {
      cause: {
        txid,
        signedTx: base64.encode(signedTx.toPSBT()),
        signedCheckpointTxs,
      },
    },
  );
}

/** Construct get-pending-tx intent */
const message: Intent.GetPendingTxMessage = {
  type: "get-pending-tx",
  expire_at: 0,
};
/** Construct ownership proof of (spent) funds */
const proof = Intent.create(
  message,
  inputs.map((input) => ({
    ...input,
    forfeitTapLeafScript: userScript.forfeit(),
    intentTapLeafScript: userScript.forfeit(),
    tapTree: userScript.encode(),
  })),
  [],
);
const signedProof = await userIdentity.sign(proof);
const signedIntent: SignedIntent<Intent.GetPendingTxMessage> = {
  proof: base64.encode(signedProof.toPSBT()),
  message,
};
console.log("Generated signed get-pending-tx intent:", signedIntent);

console.log("Fetching pending transactions...");
const pendingTxs = await operator.getPendingTxs(signedIntent);
console.log(`Fetched ${pendingTxs.length} pending transactions:`, [
  pendingTxs.map(({ arkTxid }) => arkTxid),
]);

for (const {
  arkTxid: txid,
  finalArkTx: signedTx,
  signedCheckpointTxs,
} of pendingTxs) {
  console.log("Finalizing signed checkpoint transactions...", {
    txid,
    signedTx,
    signedCheckpointTxs,
  });
  const finalizedCheckpointTxs = await Promise.all(
    signedCheckpointTxs.map(async (signedCheckpointTx) => {
      let finalizedCheckpointTx = Transaction.fromPSBT(
        base64.decode(signedCheckpointTx),
      );
      console.log("Finalizing checkpoint transaction...");
      finalizedCheckpointTx = await userIdentity.sign(finalizedCheckpointTx);
      return base64.encode(finalizedCheckpointTx.toPSBT());
    }),
  );
  console.log("Finalized checkpoint transactions:", {
    txid,
    signedTx,
    finalizedCheckpointTxs,
  });

  console.log("Finalizing transaction...");
  await operator.finalizeTx(txid, finalizedCheckpointTxs);

  console.log("Broadcasted!", `${EXPLORER_URL}/tx/${txid}`);
}
