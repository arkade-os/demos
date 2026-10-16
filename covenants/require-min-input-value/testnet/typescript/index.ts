import {
  arkade,
  buildOffchainTx,
  setArkPsbtField,
  getNetwork,
  PrevArkTxField,
  EmulatorPacket,
  Extension,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Transaction,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";

const { Arkade: ContractBuilder } = arkade;
type Program = typeof arkade.Program;

const INSPECTED_INPUT_INDEX = 0;
const MIN_AMOUNT = 1_000n;

/**
 * A basic covenant contract program, `requireMinInputValue`, that only lets the operator move funds
 * when input[INSPECTED_INPUT_INDEX] is worth at least MIN_AMOUNT.
 */
const program = {
  version: 0,
  params: ["operatorPubkey", "ownerPubkey", "minAmount"],
  functions: {
    requireMinInputValue: {
      /** Signers: the operator plus a fresh per-run key, which makes this contract address unique per run. */
      tapscript: { signers: ["$operatorPubkey", "$ownerPubkey"] },
      /** Covenant clause executed by the emulator on every spend. */
      arkadeScript: {
        asm: [INSPECTED_INPUT_INDEX, "INSPECTINPUTVALUE", "$minAmount", "GREATERTHANOREQUAL"],
      },
    },
  },
} as const satisfies Program;

const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;
const FAUCET_URL = "https://faucet.mutinynet.arkade.sh/faucet" as const;

/** 1. Create script builder with support for cosigner, indexer and emulator. */
const operator = new RestArkProvider(OPERATOR_URL);
const indexer = new RestIndexerProvider(OPERATOR_URL);
const emulator = new RestEmulatorProvider(EMULATOR_URL);
const network = getNetwork("mutinynet");

const builder = await ContractBuilder.connect({
  arkade: operator,
  indexer,
  emulator,
  network,
});

/** A fresh per-run key. Adding it as a signer makes this contract address unique to this run,
 *  so concurrent runs get separate addresses and never touch each other's coins. */
const identity = SingleKey.fromPrivateKey(crypto.getRandomValues(new Uint8Array(32)));
const ownerPubkey = await identity.xOnlyPublicKey();

/** 2. Instantiate the contract, binding the program's params to concrete values. */
const contract = builder.contract(program, {
  operatorPubkey: builder.serverKey,
  ownerPubkey,
  minAmount: MIN_AMOUNT,
});

/** Fund the contract so the demo runs end to end without a separate manual step. */
await fundViaFaucet(contract.address, Number(MIN_AMOUNT));

/** 3. Wait for the funded coin to land, then check the contract can be executed. */
const contractInputs = await waitFor(() => contract.getUtxos(), "contract funding from the faucet");

const contractBalance = contractInputs.reduce(
  (total, input) => total + BigInt(input.value),
  0n,
);

/** The covenant inspects input 0, so that coin must clear the minimum. */
const firstInputValue = BigInt(contractInputs[0].value);
if (firstInputValue < MIN_AMOUNT) {
  throw new Error("Coin at input 0 is below the required minimum", {
    cause: { 
      address: contract.address, 
      min: MIN_AMOUNT, 
      got: firstInputValue,
     },
  });
}

/** The compiled `requireMinInputValue` spending path: its tapscript leaf and raw arkadeScript bytes. */
const requireMinInputValue = contract.vtxoScript.functionByName("requireMinInputValue")!;

/** Transform into PSBT inputs, all spent via the same `requireMinInputValue` leaf. */
const inputs = contractInputs.map(({ txid, vout, value }) => ({
  txid,
  vout,
  value,
  /** The tapscript leaf (+ control block) authorizing this spend. */
  tapLeafScript: requireMinInputValue.tapLeafScript,
  /** The contract's encoded taproot script tree. */
  tapTree: contract.tapTree,
}));

/**
 * This covenant constrains an input's value, not any output, so there is no
 * exact-amount output to build: the whole balance goes back to the contract.
 */
const outputs = [{ script: contract.pkScript, amount: contractBalance }];

/**
 * Construct Arkade extension envelope.
 * The emulator executes `requireMinInputValue`'s arkadeScript once per covenant input,
 * so we need one packet entry per input index, all pointing at the same script.
 */
outputs.push(
  Extension.create([
    EmulatorPacket.create(
      inputs.map((_, vin) => ({ vin, script: requireMinInputValue.arkadeScript! })),
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

/** Attach each input's source transaction as its PrevArkTxField, which the emulator requires. */
for (let i = 0; i < inputs.length; i++) {
  const { txs } = await indexer.getVirtualTxs([inputs[i].txid]);
  if (!txs[0]) {
    throw new Error(`indexer returned no virtual tx for input txid ${inputs[i].txid}`);
  }
  const sourceTx = Transaction.fromPSBT(base64.decode(txs[0])).unsignedTx;
  setArkPsbtField(arkTx, i, PrevArkTxField, sourceTx);
}

/**
 * 5. Sign with our per-run key, then submit.
 * The covenant leaf needs the operator (arkd), the emulator (covenant), and our per-run key,
 * so we sign every input and every checkpoint before handing it to the emulator.
 */
const inputIndexes = inputs.map((_, i) => i);
const signedArkTx = await identity.sign(arkTx, inputIndexes);
const signedCheckpoints = await Promise.all(checkpoints.map((c) => identity.sign(c)));
const submitted = await builder.emulator!.submitTx(
  base64.encode(signedArkTx.toPSBT()),
  signedCheckpoints.map((c) => base64.encode(c.toPSBT())),
);

/**
 * 6. Extract the finalized transaction's ID
 */
const txid = Transaction.fromPSBT(base64.decode(submitted.signedArkTx)).id;
console.log(
  `Covenant satisfied: input 0 (the inspected coin) met the ${MIN_AMOUNT}-sat minimum, spent ${inputs.length} input(s): ${EXPLORER_URL}/tx/${txid}`,
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask the Arkade faucet to fund an ark address directly (offchain). */
async function fundViaFaucet(address: string, amount: number): Promise<void> {
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, amount }),
  });
  if (!res.ok) throw new Error(`faucet failed: ${res.status} ${await res.text()}`);
}

/** Poll until a lookup returns at least one item, or time out. */
async function waitFor<T>(
  lookup: () => Promise<T[]>,
  label: string,
  timeoutMs = 60_000,
): Promise<T[]> {
  console.log(`Waiting for ${label}...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await lookup();
    if (items.length > 0) return items;
    await sleep(3_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}
