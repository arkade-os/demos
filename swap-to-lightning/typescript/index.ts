import {
  ArkAddress,
  buildOffchainTx,
  CSVMultisigTapscript,
  DelegateVtxo,
  MnemonicIdentity,
  networks,
  ReadonlySingleKey,
  RestArkProvider,
  RestDelegatorProvider,
  RestIndexerProvider,
  Transaction,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import ky from "ky";

const INVOICE_AMOUNT = 1_000n as const;
const LN_ADDRESS = "refund@lnurl.mutinynet.com" as const;

const ALICE_SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const NETWORK = networks.mutinynet;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const BOLTZ_API = "https://api.boltz.mutinynet.arkade.sh" as const;
const DUST = 330n;

console.log("Setting up user identity...");
const userIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED, {
  isMainnet: false,
});
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

console.log("Connecting to indexer...");
const indexer = new RestIndexerProvider("https://mutinynet.arkade.sh");

console.log("Fetching inputs for user...");
const inputs = await indexer
  .getVtxos({
    scripts: [hex.encode(userAddress.pkScript)],
    spendableOnly: true,
  })
  .then(({ vtxos }) =>
    vtxos
      /** Filter out inputs with Arkade assets */
      .filter((input) => !input.assets?.length),
  );
const inputTotal = inputs.reduce((sum, input) => sum + BigInt(input.value), 0n);
console.log("User balance:", [inputTotal]);

if (inputTotal === 0n) {
  throw new Error(`Address not funded.

Address:
- ${userAddress.encode()}
`);
}

console.log("Validating LUD-16 address:", [LN_ADDRESS]);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(LN_ADDRESS)) {
  throw new Error(`Invalid LN_ADDRESS`);
}
const [lud16User, lud16Domain] = LN_ADDRESS.split("@");

console.log("Fetching LUD-16 callback...");
const lud16Callback = await ky
  .get(`https://${lud16Domain}/.well-known/lnurlp/${lud16User}`)
  .json<{ callback: string }>()
  .then(({ callback }) => callback);
console.log("Fetched LUD-16 callback:", lud16Callback);

console.log("Fetching BOLT-11 invoice...");
const invoice = await ky
  .get(lud16Callback, {
    searchParams: {
      amount: (INVOICE_AMOUNT * 1000n).toString(),
    },
  })
  .json<{
    pr: string;
  }>()
  .then(({ pr }) => pr);
console.log("Fetched BOLT-11 invoice", [invoice]);

console.log("Fetching submarine swap limits...");
const limits = await ky
  .get(`${BOLTZ_API}/v2/swap/submarine`)
  .json<{
    ARK: {
      BTC: {
        limits: {
          maximal: number;
          minimal: number;
        };
      };
    };
  }>()
  .then((limits) => ({
    min: BigInt(limits.ARK.BTC.limits.minimal),
    max: BigInt(limits.ARK.BTC.limits.maximal),
  }));
console.log("Fetched submarine swap limits:", limits);

if (INVOICE_AMOUNT < limits.min) {
  throw new Error(
    `Amount (${INVOICE_AMOUNT}) below swap minimum: ${limits.min}`,
  );
}
if (INVOICE_AMOUNT > limits.max) {
  throw new Error(
    `Amount (${INVOICE_AMOUNT}) above swap maximum: ${limits.max}`,
  );
}

console.log("Creating submarine swap...");
const swap = await ky
  .post(`${BOLTZ_API}/v2/swap/submarine`, {
    json: {
      from: "ARK",
      to: "BTC",
      invoice,
      refundPublicKey: hex.encode(userPubkeyCompressed),
    },
  })
  .json<{
    /** Amount in satoshis to send. */
    expectedAmount: number;
    /** Arkade lockup address to send funds to. */
    address: string;
  }>();
console.log("Created submarine swap:", swap);

const swapAddress = ArkAddress.decode(swap.address);
const swapAmount = BigInt(swap.expectedAmount);

if (inputTotal < swapAmount) {
  throw new Error(`Address does not have enough for swap.

Need:
- ${swapAmount - inputTotal}

Address:
- ${userAddress.encode()}
`);
}

const changeAmount = inputTotal - swapAmount;
const changeOutput =
  changeAmount < DUST
    ? {
        script: Script.encode(["RETURN", userAddress.subdustPkScript]),
        amount: changeAmount,
      }
    : {
        script: userAddress.pkScript,
        amount: changeAmount,
      };

console.log("Funding lockup address...");
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
    {
      script: swapAddress.pkScript,
      amount: swapAmount,
    },
    changeOutput,
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
