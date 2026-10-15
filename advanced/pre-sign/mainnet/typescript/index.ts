import {
  buildOffchainTx,
  combineTapscriptSigs,
  CSVMultisigTapscript,
  DelegateVtxo,
  MnemonicIdentity,
  networks,
  type RelativeTimelock,
  RestArkProvider,
  RestDelegateProvider,
  RestIndexerProvider,
  Transaction,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const NETWORK = networks.bitcoin;
const DELEGATE_URL = "https://delegate.arkade.money" as const;
const EXPLORER_URL = "https://arkade.space" as const;

/** 1. Create user identity */
const userIdentity = MnemonicIdentity.fromMnemonic(SEED_PHRASE);

/** 2. Extract user x-only public key */
const userPubkey = await userIdentity.xOnlyPublicKey();

/** 3. Connect to operator */
const operator = new RestArkProvider();
const operatorInfo = await operator.getInfo();

/** 4. Extract operator x-only public key */
const operatorPubkey = hex.decode(operatorInfo.signerPubkey).slice(1);

/** 5. Extract operator unilateral exit timelock */
const exitTimelock = {
  value: BigInt(operatorInfo.unilateralExitDelay),
  type: "seconds",
} as const satisfies RelativeTimelock;

/** 6. Extract operator checkpoint tapscript */
const checkpointTapscript = CSVMultisigTapscript.decode(
  hex.decode(operatorInfo.checkpointTapscript),
);

/** 7. Connect to delegate */
const delegate = new RestDelegateProvider(DELEGATE_URL);
const delegateInfo = await delegate.getDelegateInfo();

/** 8. Extract delegate x-only public key */
const delegatePubkey = hex.decode(delegateInfo.pubkey).slice(1);

/** 9. Construct delegated payment contract */
const contract = new DelegateVtxo.Script({
  pubKey: userPubkey,
  serverPubKey: operatorPubkey,
  delegatePubKey: delegatePubkey,
  csvTimelock: exitTimelock,
});

/** 10. Connect to indexer */
const indexer = new RestIndexerProvider();

/** 11. Fetch outputs (ignore assets) */
const outputs = await indexer
  .getVtxos({
    spendableOnly: true,
    scripts: [hex.encode(contract.pkScript)],
  })
  .then(({ vtxos }) => vtxos.filter((output) => !output.assets?.length));

/** 12. Calculate balance */
const balance = outputs.reduce(
  (total, output) => total + BigInt(output.value),
  0n,
);

if (balance < 330n) {
  throw new Error("No spendable balance", {
    cause: contract.address(NETWORK.hrp, operatorPubkey).encode(),
  });
}

/** 13. Construct first transaction (consolidation) */
const { arkTx: consolidationTx, checkpoints: consolidationCheckpoints } =
  buildOffchainTx(
    outputs.map(({ txid, vout, value }) => ({
      txid,
      vout,
      value,
      tapLeafScript: contract.forfeit(),
      tapTree: contract.encode(),
    })),
    [
      {
        amount: balance,
        script: contract.pkScript,
      },
    ],
    checkpointTapscript,
  );

/** 14. Construct second transaction (split) */
const consolidationOutput = consolidationTx.getOutput(0)!;
const splitCount = Math.floor(Number(balance / 330n));
const { arkTx: splitTx, checkpoints: splitCheckpoints } = buildOffchainTx(
  [
    {
      txid: consolidationTx.id,
      vout: 0,
      value: Number(consolidationOutput.amount!),
      tapLeafScript: contract.forfeit(),
      tapTree: contract.encode(),
    },
  ],
  [
    ...Array(splitCount - 1).fill({
      amount: 330n,
      script: contract.pkScript,
    }),
    {
      amount: balance - 330n * BigInt(splitCount - 1),
      script: contract.pkScript,
    },
  ],
  checkpointTapscript,
);

/** 15. Sign everything at once */
const signedConsolidationTx = await userIdentity.sign(consolidationTx);
const userSignedConsolidationCheckpoints = await Promise.all(
  consolidationCheckpoints.map((checkpoint) => userIdentity.sign(checkpoint)),
);
const signedSplitTx = await userIdentity.sign(splitTx);
const userSignedSplitCheckpoints = await Promise.all(
  splitCheckpoints.map((checkpoint) => userIdentity.sign(checkpoint)),
);

/**
 * 16. Submit first tx to server
 * Checkpoints go unsigned: the user's checkpoint signatures are only added
 * at finalization, as the operator won't finalize checkpoints submitted pre-signed
 */
const { signedCheckpointTxs: serverSignedConsolidationCheckpoints } =
  await operator.submitTx(
    base64.encode(signedConsolidationTx.toPSBT()),
    consolidationCheckpoints.map((tx) => base64.encode(tx.toPSBT())),
  );

/** 17. Merge first checkpoint signatures */
const finalizedConsolidationCheckpoints =
  serverSignedConsolidationCheckpoints.map((checkpoint) => {
    const serverSignedCheckpoint = Transaction.fromPSBT(
      base64.decode(checkpoint),
    );
    const userSignedCheckpoint = userSignedConsolidationCheckpoints.find(
      (_checkpoint) => _checkpoint.id === serverSignedCheckpoint.id,
    )!;
    return combineTapscriptSigs(userSignedCheckpoint, serverSignedCheckpoint);
  });

/** 18. Finalize first tx with server */
await operator.finalizeTx(
  consolidationTx.id,
  finalizedConsolidationCheckpoints.map((checkpoint) =>
    base64.encode(checkpoint.toPSBT()),
  ),
);
console.log(
  `Finalized first transaction (consolidation): ${EXPLORER_URL}/tx/${consolidationTx.id}`,
);

/** 19. Submit second tx to server (checkpoints unsigned, as in step 16) */
const { signedCheckpointTxs: serverSignedSplitCheckpoints } =
  await operator.submitTx(
    base64.encode(signedSplitTx.toPSBT()),
    splitCheckpoints.map((tx) => base64.encode(tx.toPSBT())),
  );

/** 20. Merge second checkpoint signatures */
const finalizedSplitCheckpoints = serverSignedSplitCheckpoints.map(
  (checkpoint) => {
    const serverSignedCheckpoint = Transaction.fromPSBT(
      base64.decode(checkpoint),
    );
    const userSignedCheckpoint = userSignedSplitCheckpoints.find(
      (_checkpoint) => _checkpoint.id === serverSignedCheckpoint.id,
    )!;
    return combineTapscriptSigs(userSignedCheckpoint, serverSignedCheckpoint);
  },
);

/** 21. Finalize second tx with server */
await operator.finalizeTx(
  splitTx.id,
  finalizedSplitCheckpoints.map((checkpoint) =>
    base64.encode(checkpoint.toPSBT()),
  ),
);
console.log(
  `Finalized second transaction (split): ${EXPLORER_URL}/tx/${splitTx.id}`,
);
