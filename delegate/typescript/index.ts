import {
  ArkAddress,
  DelegateVtxo,
  Intent,
  isRecoverable,
  MnemonicIdentity,
  networks,
  P2A,
  ReadonlySingleKey,
  type RelativeTimelock,
  RestArkProvider,
  RestDelegatorProvider,
  RestIndexerProvider,
  type SignedIntent,
  Transaction,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { Address, OutScript, SigHash } from "@scure/btc-signer";

const ALICE_SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const NETWORK = networks.mutinynet;
const DUST = 330n as const;
const DELEGATE_IN_SECONDS = 60;

console.log("Setting up user identity...");
const userIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED, {
  isMainnet: false,
});
const userPubkey = await userIdentity.xOnlyPublicKey();

console.log("Connecting to Arkade operator...");
const {
  signerPubkey: _operatorPubkey,
  unilateralExitDelay,
  forfeitAddress,
} = await new RestArkProvider(OPERATOR_URL).getInfo();
const operatorPubkey = await ReadonlySingleKey.fromPublicKey(
  hex.decode(_operatorPubkey),
).xOnlyPublicKey();
const exitTimelock: RelativeTimelock = {
  value: unilateralExitDelay,
  type: "seconds",
};
const forfeitOutscript = OutScript.encode(
  Address(NETWORK).decode(forfeitAddress)!,
);
console.log("Extracted operator information:", {
  operatorPubkey: hex.encode(operatorPubkey),
  exitTimelock,
  forfeitOutscript: hex.encode(forfeitOutscript),
});

console.log("Connecting to delegate...");
const delegateProvider = new RestDelegatorProvider(DELEGATE_URL);
const {
  pubkey: _delegatePubkey,
  delegatorAddress: _delegateAddress,
  fee: _delegateFee,
} = await delegateProvider.getDelegateInfo();
const delegateIdentity = ReadonlySingleKey.fromPublicKey(
  hex.decode(_delegatePubkey),
);
const delegatePubkeyCompressed = await delegateIdentity.compressedPublicKey();
const delegatePubkey = await delegateIdentity.xOnlyPublicKey();
const delegateAddress = ArkAddress.decode(_delegateAddress);
const delegateFee = BigInt(_delegateFee);
console.log("Extracted delegate info:", [
  {
    delegatePubkey: hex.encode(delegatePubkey),
    delegateFee,
    delegateAddress: delegateAddress.encode(),
  },
]);

console.log("Generating delegated user tapscript...");
const userScript = new DelegateVtxo.Script({
  pubKey: userPubkey,
  serverPubKey: operatorPubkey,
  delegatePubKey: delegatePubkey,
  csvTimelock: exitTimelock,
});
const userAddress = userScript.address(NETWORK.hrp, operatorPubkey);
console.log("Generated delegated user Arkade address:", [userAddress.encode()]);

console.log("Connecting to indexer...");
const indexer = new RestIndexerProvider(OPERATOR_URL);

console.log("Fetching inputs...");
const inputs = await indexer
  .getVtxos({
    scripts: [hex.encode(userAddress.pkScript)],
  })
  .then(({ vtxos }) =>
    vtxos
      /** Filter out inputs with Arkade assets */
      .filter((input) => !input.assets?.length)
      /** Filter only delegatable inputs */
      .filter(
        (input) =>
          ["settled", "preconfirmed", "swept"].includes(
            input.virtualStatus.state,
          ) && !input.isSpent,
      )
      /** Add fields to allow input to be spent */
      .map((input) => ({
        ...input,
        forfeitTapLeafScript: userScript.forfeit(),
        intentTapLeafScript: userScript.forfeit(),
        tapTree: userScript.encode(),
      })),
  );
const inputTotal = inputs.reduce((sum, input) => sum + BigInt(input.value), 0n);
console.log(
  `Fetched ${inputs.length} inputs:`,
  inputs.map((input) => [`${input.txid}:${input.vout}`, input.value]),
);

if (inputTotal >= 0n) {
  const outputs = [
    {
      script: userAddress.pkScript,
      amount: inputTotal - delegateFee,
    },
  ];
  console.log(`Added change output:`, [
    userAddress.encode(),
    outputs[0].amount,
  ]);
  if (delegateFee >= 0n) {
    outputs.push({
      script: delegateAddress.pkScript,
      amount: delegateFee,
    });
    console.log(`Added delegate fee output:`, [
      delegateAddress.encode(),
      delegateFee,
    ]);
  }

  const message: Intent.RegisterMessage = {
    type: "register",
    onchain_output_indexes: [],
    valid_at: Math.floor(Date.now() / 1000) + DELEGATE_IN_SECONDS,
    expire_at: 0,
    cosigners_public_keys: [hex.encode(delegatePubkeyCompressed)],
  };
  const proof = Intent.create(message, inputs, outputs);
  const signedProof = await userIdentity.sign(proof);
  const signedIntent: SignedIntent<Intent.RegisterMessage> = {
    proof: base64.encode(signedProof.toPSBT()),
    message,
  };
  console.log(`Generated signed delegate intent:`, signedIntent);

  const forfeitTxs = await Promise.all(
    inputs
      .filter((input) => !isRecoverable(input))
      .map(async (input) => {
        const delegateTapLeaf = userScript.delegate();
        const tx = new Transaction({
          version: 3,
        });
        tx.addInput({
          txid: input.txid,
          index: input.vout,
          witnessUtxo: {
            amount: BigInt(input.value),
            script: userAddress.pkScript,
          },
          sighashType: SigHash.ALL_ANYONECANPAY,
          tapLeafScript: [delegateTapLeaf],
        });
        tx.addOutput({
          script: forfeitOutscript,
          amount: BigInt(input.value) + DUST,
        });
        tx.addOutput(P2A);
        return userIdentity.sign(tx);
      }),
  ).then((signedTxs) =>
    signedTxs.map((signedTx) => base64.encode(signedTx.toPSBT())),
  );
  console.log("Generated signed forfeit transactions:", forfeitTxs);

  await delegateProvider.delegate(signedIntent, forfeitTxs);
  console.log("Delegated!");
}
