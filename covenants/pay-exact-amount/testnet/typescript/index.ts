import {
  arkade,
  buildOffchainTx,
  EmulatorPacket,
  Extension,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  Transaction,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

const { Arkade: ContractBuilder, Script } = arkade;
type Program = typeof arkade.Program;
const DUST = 330n;

const OUTPUT_INDEX = 0;
const OUTPUT_AMOUNT = 1_000n;

/**
 * A basic covenant contract program, `payExactAmount`, that only lets the operator move funds
 * when output[OUTPUT_INDEX] pays exactly OUTPUT_AMOUNT.
 */
const program = {
  version: 0,
  params: ["operatorPubkey", "outputAmount"],
  functions: {
    payExactAmount: {
      /** Tapscript-level signer requirement: only the operator key. */
      tapscript: { signers: ["$operatorPubkey"] },
      /** Covenant clause executed by the emulator on every spend. */
      arkadeScript: {
        asm: [OUTPUT_INDEX, "INSPECTOUTPUTVALUE", "$outputAmount", "EQUAL"],
      },
    },
  },
} as const satisfies Program;

const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

/** 1. Create script builder with support for cosigner, indexer and emulator. */
const builder = await ContractBuilder.connect({
  arkade: new RestArkProvider(OPERATOR_URL),
  indexer: new RestIndexerProvider(OPERATOR_URL),
  emulator: new RestEmulatorProvider(EMULATOR_URL),
});

/** 2. Instantiate the contract, binding the program's params to concrete values. */
const contract = builder.contract(program, {
  operatorPubkey: builder.serverKey,
  outputAmount: OUTPUT_AMOUNT,
});

/** 3. Fetch contract inputs and determine whether the contract can be executed. */
const contractInputs = await contract.getUtxos();

const contractBalance = contractInputs.reduce(
  (total, input) => total + BigInt(input.value),
  0n,
);

if (contractBalance < OUTPUT_AMOUNT) {
  throw new Error("Contract address not funded", {
    cause: {
      address: contract.address,
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

/** 4. Build the unsigned virtual transaction */
const { arkTx, checkpoints } = buildOffchainTx(
  inputs,
  outputs,
  /** The operator's checkpoint unroll tapscript. */
  builder.checkpoint,
);

/**
 * 5. Submit transaction.
 * `payExactAmount` is signed only by the operator (`$operatorPubkey`)
 * No client identity is involved, so the unsigned transaction goes straight to the emulator
 */
const submitted = await builder.emulator!.submitTx(
  base64.encode(arkTx.toPSBT()),
  checkpoints.map((c) => base64.encode(c.toPSBT())),
);

/**
 * 6. Extract the finalized transaction's ID
 */
const txid = Transaction.fromPSBT(base64.decode(submitted.signedArkTx)).id;
console.log(
  `Spent ${inputs.length} contract input(s): ${EXPLORER_URL}/tx/${txid}`,
);
