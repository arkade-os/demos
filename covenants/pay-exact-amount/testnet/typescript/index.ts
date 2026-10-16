import {
  arkade,
  attachPrevArkTxs,
  buildOffchainTx,
  EmulatorPacket,
  Extension,
  MnemonicIdentity,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  Transaction,
  networks
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

const { Arkade: ContractBuilder, Script } = arkade;
type Program = typeof arkade.Program;
const DUST = 330n;

const OUTPUT_INDEX = 0;
const OUTPUT_AMOUNT = 1_000n;

/**
 * A basic covenant contract program, `payExactAmount`, that only lets the user move funds
 * when output[OUTPUT_INDEX] pays exactly OUTPUT_AMOUNT.
 */
const program = {
  version: 0,
  params: ["emulatorPubkey", "userPubkey", "operatorPubkey", "outputAmount"],
  functions: {
    payExactAmount: {
      /**
       * Tapscript-level signers, in signing order: the emulator (its key tweaked by the
       * covenant), then the user, then the operator. With the user after the emulator,
       * the emulator only co-signs and hands the tx back, so the user submits it to arkd.
       * `emulator: null` stops the SDK appending the emulator key a second time.
       */
      tapscript: {
        signers: [
          { tweak: "$emulatorPubkey", fn: "payExactAmount" },
          "$userPubkey",
          "$operatorPubkey",
        ],
        emulator: null,
      },
      /** Covenant clause executed by the emulator on every spend. */
      arkadeScript: {
        asm: [OUTPUT_INDEX, "INSPECTOUTPUTVALUE", "$outputAmount", "EQUAL"],
      },
    },
  },
} as const satisfies Program;

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

/** 1. Create user identity */
const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
  isMainnet: false,
});

/** 2. Create script builder with support for cosigner, indexer and emulator. */
const operator = new RestArkProvider(OPERATOR_URL);
const indexer = new RestIndexerProvider(OPERATOR_URL);
const builder = await ContractBuilder.connect({
  arkade: operator,
  indexer,
  emulator: new RestEmulatorProvider(EMULATOR_URL),
});

/** 3. Instantiate the contract, binding the program's params to concrete values. */
const contract = builder.contract(program, {
  emulatorPubkey: builder.emulatorKey!,
  userPubkey: await identity.xOnlyPublicKey(),
  operatorPubkey: builder.serverKey,
  outputAmount: OUTPUT_AMOUNT,
});

/** 4. Fetch contract inputs and determine whether the contract can be executed. */
const contractInputs = await contract.getUtxos();

const contractBalance = contractInputs.reduce(
  (total, input) => total + BigInt(input.value),
  0n,
);

if (contractBalance < OUTPUT_AMOUNT) {
  throw new Error("Contract address not funded", {
    cause: {
      // TODO: temp workaround for contract.address() defaulting to mainnet
      address: contract.vtxoScript.address(networks.mutinynet.hrp, builder.serverKey).encode(),
      expected: OUTPUT_AMOUNT,
      received: contractBalance,
      need: OUTPUT_AMOUNT - contractBalance,
    },
  });
}

/** The compiled `payExactAmount` spending path: its tapscript leaf and raw arkadeScript bytes. */
const payExactAmount = contract.vtxoScript.functionByName("payExactAmount")!;

/** Transform into PSBT inputs, all spent via the same `payExactAmount` leaf. */
const inputs = contractInputs.map(({ txid, vout, value }) => ({
  txid,
  vout,
  value,
  /** The tapscript leaf (+ control block) authorizing this spend. */
  tapLeafScript: payExactAmount.tapLeafScript,
  /** The contract's encoded taproot script tree. */
  tapTree: contract.tapTree,
}));

/**
 * The covenant demands output[OUTPUT_INDEX].value === OUTPUT_AMOUNT exactly,
 * so any surplus from consolidating multiple inputs needs its own output.
 */
const outputs = [{ script: contract.pkScript, amount: OUTPUT_AMOUNT }];
const change = contractBalance - OUTPUT_AMOUNT;

/** Only add a change output when there actually is a surplus. */
if (change >= DUST) {
  outputs.push({ script: contract.pkScript, amount: change });
} else if (change > 0n) {
  outputs.push({
    script: Script.encode(["RETURN", contract.vtxoScript.tweakedPublicKey]),
    amount: change,
  });
}

/**
 * Construct Arkade extension envelope.
 * The emulator executes `payExactAmount`'s arkadeScript once per covenant input,
 * so we need one packet entry per input index, all pointing at the same script.
 */
outputs.push(
  Extension.create([
    EmulatorPacket.create(
      inputs.map((_, vin) => ({ vin, script: payExactAmount.arkadeScript! })),
    ),
  ]).txOut(),
);

/** 5. Build the unsigned virtual transaction */
const { arkTx, checkpoints } = buildOffchainTx(
  inputs,
  outputs,
  /** The operator's checkpoint unroll tapscript. */
  builder.checkpoint,
);

/**
 * 6. Attach the transaction that created each input's coin.
 * The emulator needs it to introspect the inputs, and rejects the submission without it.
 */
await attachPrevArkTxs(
  arkTx,
  inputs.map(({ txid }) => txid),
  indexer,
);

/**
 * 7. Have the emulator run the covenant and co-sign.
 * The user signs after it, so it returns the tx instead of submitting it to arkd.
 */
const coSigned = await builder.emulator!.submitTx(
  base64.encode(arkTx.toPSBT()),
  checkpoints.map((c) => base64.encode(c.toPSBT())),
);

/** 8. Add the user's signatures to the ark tx and its checkpoints */
const signedArkTx = await identity.sign(
  Transaction.fromPSBT(base64.decode(coSigned.signedArkTx)),
);
const signedCheckpoints = await Promise.all(
  coSigned.signedCheckpointTxs.map((checkpoint) =>
    identity.sign(Transaction.fromPSBT(base64.decode(checkpoint)), [0]),
  ),
);

/**
 * 9. Submit to arkd.
 * The checkpoints arrive fully signed, so arkd finalizes the tx on submit: no finalize call.
 */
const { arkTxid } = await operator.submitTx(
  base64.encode(signedArkTx.toPSBT()),
  signedCheckpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
);
console.log(
  `Spent ${inputs.length} contract input(s): ${EXPLORER_URL}/tx/${arkTxid}`,
);
