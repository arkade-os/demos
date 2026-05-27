import {
  buildOffchainTx,
  ConditionWitness,
  CSVMultisigTapscript,
  DelegateVtxo,
  MnemonicIdentity,
  networks,
  ReadonlySingleKey,
  RestArkProvider,
  RestDelegatorProvider,
  RestIndexerProvider,
  setArkPsbtField,
  Transaction,
  VHTLC,
} from "@arkade-os/sdk";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64, hex } from "@scure/base";
import ky from "ky";
import bolt11 from "light-bolt11-decoder";

const PREIMAGE = "" as const;
const REFUND_LOCKTIME = 0n as const;
const INVOICE_AMOUNT = 1_000n;

const ALICE_SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const NETWORK = networks.mutinynet;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const BOLTZ_API = "https://api.boltz.mutinynet.arkade.sh" as const;

const isNewSwap = hex.decode(PREIMAGE).length !== 32;
const preimage = isNewSwap ? randomBytes(32) : hex.decode(PREIMAGE);

if (
  !isNewSwap &&
  (Number.isNaN(Number(REFUND_LOCKTIME)) ||
    Math.floor(new Date().getTime() / 1000) > Number(REFUND_LOCKTIME))
) {
  throw new Error(
    "REFUND_LOCKTIME must be set to a valid future timestamp if PREIMAGE is defined",
    {
      cause: {
        REFUND_LOCKTIME,
      },
    },
  );
}

console.log("Setting up user identity...");
const _userIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED, {
  isMainnet: false,
});
console.log("Modifying signer to add ConditionWitness PSBT fields...");
const userIdentity = {
  xOnlyPublicKey: async () => await _userIdentity.xOnlyPublicKey(),
  compressedPublicKey: async () => await _userIdentity.compressedPublicKey(),
  sign: async (
    tx: Transaction,
    inputIndexes?: number[],
  ): Promise<Transaction> => {
    const clone = tx.clone();
    let signedTx = await _userIdentity.sign(clone, inputIndexes);
    signedTx = Transaction.fromPSBT(signedTx.toPSBT());
    for (const inputIndex of inputIndexes ||
      Array.from({ length: signedTx.inputsLength }, (_, i) => i)) {
      setArkPsbtField(signedTx, inputIndex, ConditionWitness, [preimage]);
    }
    return signedTx;
  },
};
const userPubkey = await userIdentity.xOnlyPublicKey();
const userPubkeyCompressed = await userIdentity.compressedPublicKey();
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
const delegate = new RestDelegatorProvider(DELEGATE_URL);
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

if (isNewSwap) {
  console.log("Fetching reverse swap limits...");
  const limits = await ky
    .get(`${BOLTZ_API}/v2/swap/reverse`)
    .json<{
      BTC: {
        ARK: {
          limits: {
            maximal: number;
            minimal: number;
          };
        };
      };
    }>()
    .then((limits) => ({
      min: BigInt(limits.BTC.ARK.limits.minimal),
      max: BigInt(limits.BTC.ARK.limits.maximal),
    }));
  console.log("Fetched reverse swap limits:", limits);

  if (INVOICE_AMOUNT < limits.min) {
    throw new Error(`Amount below swap minimum`, {
      cause: {
        amount: INVOICE_AMOUNT,
        minimum: limits.min,
      },
    });
  }
  if (INVOICE_AMOUNT > limits.max) {
    throw new Error(`Amount above swap maximum`, {
      cause: {
        amount: INVOICE_AMOUNT,
        maximum: limits.max,
      },
    });
  }
}

console.log(
  isNewSwap ? "Creating reverse swap..." : "Fetching reverse swap details...",
);
const swap = await ky
  .post(`${BOLTZ_API}/v2/swap/reverse`, {
    json: {
      from: "BTC",
      to: "ARK",
      invoiceAmount: Number(INVOICE_AMOUNT),
      claimPublicKey: hex.encode(userPubkeyCompressed),
      /** Use a random preimage in case PREIMAGE was defined */
      preimageHash: isNewSwap
        ? hex.encode(sha256(preimage))
        : hex.encode(sha256(randomBytes(32))),
      description: "Send to Arkade address",
    },
  })
  .json<{
    /** Arkade lockup address where Boltz will lock funds. */
    lockupAddress: string;
    /** Boltz's public key for the refund path. */
    refundPublicKey: string;
    /** Block heights for various timeout/refund scenarios. */
    timeoutBlockHeights: {
      refund: number;
      unilateralClaim: number;
      unilateralRefund: number;
      unilateralRefundWithoutReceiver: number;
    };
    /** BOLT11-encoded Lightning invoice to be paid. */
    invoice: string;
  }>();

/** In a production scenario, all of the following should be saved from the original swap response. */
const refundPubkey = await ReadonlySingleKey.fromPublicKey(
  hex.decode(swap.refundPublicKey),
).xOnlyPublicKey();
const refundLocktime = isNewSwap
  ? BigInt(swap.timeoutBlockHeights.refund)
  : BigInt(REFUND_LOCKTIME);
const unilateralClaimDelay = {
  value: BigInt(swap.timeoutBlockHeights.unilateralClaim),
  type: "seconds",
} as const;
const unilateralRefundDelay = {
  value: BigInt(swap.timeoutBlockHeights.unilateralRefund),
  type: "seconds",
} as const;
const unilateralRefundWithoutReceiverDelay = {
  value: BigInt(swap.timeoutBlockHeights.unilateralRefundWithoutReceiver),
  type: "seconds",
} as const;

/** Reconstruct claim address */
console.log("Reconstructing claim address...");
const claimScript = new VHTLC.Script({
  preimageHash: ripemd160(sha256(preimage)),
  sender: refundPubkey,
  receiver: userPubkey,
  server: operatorPubkey,
  refundLocktime,
  unilateralClaimDelay,
  unilateralRefundDelay,
  unilateralRefundWithoutReceiverDelay,
});
const claimAddress = claimScript.address(NETWORK.hrp, operatorPubkey);

if (isNewSwap) {
  /** Ensure invoice is valid */
  console.log("Validating BOLT-11 invoice...");
  const decoded = bolt11.decode(swap.invoice);
  const invoice = {
    paymentRequest: decoded.paymentRequest,
    expiry: BigInt(decoded.expiry) ?? 3600n,
    amountSats: BigInt(
      Math.floor(
        Number(decoded.sections.find((s) => s.name === "amount")?.value ?? "0"),
      ) / 1000,
    ),
    description:
      decoded.sections.find((s) => s.name === "description")?.value ?? "",
    paymentHash:
      decoded.sections.find((s) => s.name === "payment_hash")?.value ?? "",
  };
  if (invoice.amountSats !== INVOICE_AMOUNT) {
    throw new Error(`Decoded invoice amount does NOT match expected amount`, {
      cause: {
        expected: INVOICE_AMOUNT,
        received: invoice.amountSats,
      },
    });
  }
  if (invoice.paymentHash !== hex.encode(sha256(preimage))) {
    throw new Error(
      `Decoded payment hash does NOT match expected preimage hash`,
      {
        cause: {
          expected: hex.encode(sha256(preimage)),
          received: invoice.paymentHash,
        },
      },
    );
  }
  console.log("Decoded BOLT-11 invoice:", invoice);
  /** Ensure claim address matches */
  console.log("Validating claim address...");
  if (claimAddress.encode() !== swap.lockupAddress) {
    throw new Error("Derived claim address does NOT match API response", {
      cause: {
        expected: claimAddress.encode(),
        received: swap.lockupAddress,
      },
    });
  }
  console.log("Validated claim address:", claimAddress.encode());
  console.log(`Created reverse swap:`, {
    preimage: hex.encode(preimage),
    invoice: invoice.paymentRequest,
    lockupAddress: swap.lockupAddress,
    refundLocktime,
  });
  if (isNewSwap) {
    throw new Error(`
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
🚨          PREIMAGE and REFUND_LOCKTIME are not defined!           🚨
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
🚨                         Please set to:                           🚨
🚨 ${hex.encode(preimage)} 🚨
🚨                           ${refundLocktime}                             🚨
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
`);
  }
} else {
  console.log(`Fetched reverse swap:`, {
    preimage: hex.encode(preimage),
    claimAddress: claimAddress.encode(),
    refundLocktime,
  });
}

console.log("Connecting to indexer...");
const indexer = new RestIndexerProvider(OPERATOR_URL);

console.log("Fetching inputs for claim address...");
const inputs = await indexer
  .getVtxos({
    scripts: [hex.encode(claimScript.pkScript)],
    spendableOnly: true,
  })
  .then(({ vtxos }) =>
    vtxos
      /** Filter out inputs with Arkade assets */
      .filter((input) => !input.assets?.length),
  );
const inputTotal = inputs.reduce((sum, input) => sum + BigInt(input.value), 0n);
console.log("Contract balance:", [inputTotal]);

if (inputTotal === 0n) {
  throw new Error(`Claim address not funded`, {
    cause: {
      address: claimAddress.encode(),
    },
  });
}

console.log("Generating claim transaction...");
const { arkTx: tx, checkpoints: checkpointTxs } = buildOffchainTx(
  inputs.map(({ txid, vout, value }) => ({
    txid,
    vout,
    value,
    /** Make input spendable */
    tapLeafScript: claimScript.claim(),
    tapTree: claimScript.encode(),
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
console.log("Generated claim transaction:", [base64.encode(tx.toPSBT())]);
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

console.log("Finalizing signed checkpoint transactions...");
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
console.log("Finalized checkpoint transactions:", finalizedCheckpointTxs);

console.log("Finalizing transaction...");
await operator.finalizeTx(txid, finalizedCheckpointTxs);

console.log("Broadcasted!", `https://explorer.mutinynet.arkade.sh/tx/${txid}`);
