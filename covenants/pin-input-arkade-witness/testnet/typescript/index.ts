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

const DEPOSIT_AMOUNT = 1_000n;
const REQUIRED_COINS = 2;

/** The hashlock secret. Real ones are random and kept private; the demo commits to sha256(preimage). */
const PREIMAGE = new TextEncoder().encode("open-sesame");
/** sha256(preimage): the value the hashlock coin commits to (its $hash). */
const HASH = new Uint8Array(await crypto.subtle.digest("SHA-256", PREIMAGE));
/** The hashlock coin's Arkade-level witness, wire-encoded exactly as the emulator hashes it. */
const WITNESS = encodeWitness([PREIMAGE]);
/** The witness hash the pinning covenant demands: what INSPECTINPUTARKADEWITNESSHASH(0) will read. */
const EXPECTED_WITNESS_HASH = arkade.arkadeWitnessHash(WITNESS);

/**
 * One contract with two spending paths:
 *  - `hashlock` spends a coin by revealing a preimage (its Arkade witness), so that coin has a
 *    non-empty witness for the next path to inspect.
 *  - `pinInputArkadeWitness` only lets the operator move funds when input 0's Arkade witness hash
 *    equals the pinned value, i.e. input 0 was unlocked with exactly this preimage.
 */
const program = {
  version: 0,
  params: ["operatorPubkey", "ownerPubkey", "hash", "expectedWitnessHash"],
  functions: {
    hashlock: {
      /** Signers: the operator plus a fresh per-run key, which makes this contract address unique per run. */
      tapscript: { signers: ["$operatorPubkey", "$ownerPubkey"] },
      /** Consumes the preimage from its witness: sha256(preimage) must equal the committed hash. */
      arkadeScript: { asm: ["SHA256", "$hash", "EQUAL"] },
    },
    pinInputArkadeWitness: {
      /** Signers: the operator plus a fresh per-run key, which makes this contract address unique per run. */
      tapscript: { signers: ["$operatorPubkey", "$ownerPubkey"] },
      /** Reads input 0's Arkade witness hash and requires it to match the pinned value. */
      arkadeScript: {
        asm: [0, "INSPECTINPUTARKADEWITNESSHASH", "$expectedWitnessHash", "EQUAL"],
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

/** 2. Instantiate the contract, binding the owner key, the hash and the expected witness hash. */
const contract = builder.contract(program, {
  operatorPubkey: builder.serverKey,
  ownerPubkey,
  hash: HASH,
  expectedWitnessHash: EXPECTED_WITNESS_HASH,
});

/**
 * The demo spends two coins from this contract: one via the `hashlock` leaf (input 0, carries the
 * preimage witness) and one via the `pinInputArkadeWitness` leaf (input 1, inspects input 0).
 * Fund the contract twice so it runs end to end without a separate manual step.
 */
await fundViaFaucet(contract.address, Number(DEPOSIT_AMOUNT));
await fundViaFaucet(contract.address, Number(DEPOSIT_AMOUNT));

/** 3. Wait until both coins land, then spend them together. */
const contractInputs = await waitFor(async () => {
  const utxos = await contract.getUtxos();
  return utxos.length >= REQUIRED_COINS ? utxos.slice(0, REQUIRED_COINS) : [];
}, `${REQUIRED_COINS} coins from the faucet`);

const contractBalance = contractInputs.reduce(
  (total, input) => total + BigInt(input.value),
  0n,
);

/** The two compiled spending paths: their tapscript leaves and raw arkadeScript bytes. */
const hashlock = contract.vtxoScript.functionByName("hashlock")!;
const pinInputArkadeWitness = contract.vtxoScript.functionByName("pinInputArkadeWitness")!;

/** Input 0 is spent via the hashlock leaf, input 1 via the pinning leaf. Order matters: the covenant reads input 0. */
const inputs = [
  {
    txid: contractInputs[0].txid,
    vout: contractInputs[0].vout,
    value: contractInputs[0].value,
    tapLeafScript: hashlock.tapLeafScript,
    tapTree: contract.tapTree,
  },
  {
    txid: contractInputs[1].txid,
    vout: contractInputs[1].vout,
    value: contractInputs[1].value,
    tapLeafScript: pinInputArkadeWitness.tapLeafScript,
    tapTree: contract.tapTree,
  },
];

/** These covenants constrain inputs, not any output, so the whole balance goes back to the contract. */
const outputs = [{ script: contract.pkScript, amount: contractBalance }];

/**
 * Construct Arkade extension envelope, one packet entry per input.
 * Input 0 (hashlock) carries the preimage as its Arkade witness; that witness is what
 * INSPECTINPUTARKADEWITNESSHASH(0) hashes. Input 1 (the pinner) needs no witness.
 */
outputs.push(
  Extension.create([
    EmulatorPacket.create([
      { vin: 0, script: hashlock.arkadeScript!, witness: WITNESS },
      { vin: 1, script: pinInputArkadeWitness.arkadeScript! },
    ]),
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
 * Both leaves need the operator (arkd), the emulator (covenant), and our per-run key, so we sign
 * every input and every checkpoint. Input 0 also carries its preimage witness in the packet above.
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
  `Covenant satisfied: input 1 pinned input 0's witness (the hashlock preimage), spent ${inputs.length} input(s): ${EXPLORER_URL}/tx/${txid}`,
);

/** Wire-encode a witness stack the way the emulator hashes it: count, then each item length-prefixed. Assumes small items (< 253 bytes). */
function encodeWitness(items: Uint8Array[]): Uint8Array {
  const parts: number[] = [items.length];
  for (const item of items) {
    if (item.length > 252) {
      throw new Error(`encodeWitness: item too long (${item.length} bytes); use a multi-byte varint`);
    }
    parts.push(item.length);
    for (const b of item) parts.push(b);
  }
  return Uint8Array.from(parts);
}

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
