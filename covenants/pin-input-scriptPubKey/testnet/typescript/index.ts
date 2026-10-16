import {
  arkade,
  ArkAddress,
  buildOffchainTx,
  setArkPsbtField,
  getNetwork,
  PrevArkTxField,
  EmulatorPacket,
  Extension,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  SeedIdentity,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  Transaction,
  Wallet,
} from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { EventSource } from "eventsource";

const { Arkade: ContractBuilder } = arkade;
type Program = typeof arkade.Program;

const DEPOSIT_AMOUNT = 1000;
const PINNED_INPUT_INDEX = 0;
const TAPROOT_VERSION = 1;

/**
 * A basic covenant contract program, `pinInputScriptPubKey`, that only lets the operator move funds
 * when the coin at input[PINNED_INPUT_INDEX] is locked to the pinned witness program.
 */
const program = {
  version: 0,
  params: ["operatorPubkey", "pinnedWP"],
  functions: {
    pinInputScriptPubKey: {
      /** Tapscript-level signer requirement: only the operator key. */
      tapscript: { signers: ["$operatorPubkey"] },
      /** Covenant clause executed by the emulator on every spend. */
      arkadeScript: {
        asm: [
          PINNED_INPUT_INDEX,
          "INSPECTINPUTSCRIPTPUBKEY",
          TAPROOT_VERSION,
          "EQUALVERIFY",
          "$pinnedWP",
          "EQUAL",
        ],
      },
    },
  },
} as const satisfies Program;

const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;
const FAUCET_URL = "https://faucet.mutinynet.arkade.sh/faucet" as const;

/** The wallet uses server sent events, so give Node a global EventSource. */
(globalThis as any).EventSource = EventSource;

/** 1. Create a wallet to own coin A, and a builder with cosigner, indexer and emulator. */
/** Fresh random identity per run, so this run's coin A is isolated from other runs on the demo. */
const identity = SeedIdentity.fromSeed(crypto.getRandomValues(new Uint8Array(64)), { isMainnet: false });
const operator = new RestArkProvider(OPERATOR_URL);
const indexer = new RestIndexerProvider(OPERATOR_URL);
const emulator = new RestEmulatorProvider(EMULATOR_URL);
const network = getNetwork("mutinynet");

const wallet = await Wallet.create({
  identity,
  arkProvider: operator,
  indexerProvider: indexer,
  settlementConfig: false,
  storage: {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  },
});

const builder = await ContractBuilder.connect({
  identity,
  arkade: operator,
  indexer,
  emulator,
  network,
});

/** 2. Instantiate the contract, pinning input 0 to the wallet's witness program. */
const walletAddress = await wallet.getAddress();
const walletPkScript = ArkAddress.decode(walletAddress).pkScript;

const contract = builder.contract(program, {
  operatorPubkey: builder.serverKey,
  /** The witness program is the taproot key: the pkScript without its 2-byte version+push prefix. */
  pinnedWP: walletPkScript.subarray(2),
});

/** 3. Fund coin A and the guard, then fetch both spendable coins. */
await fundViaFaucet(walletAddress, DEPOSIT_AMOUNT);
await fundViaFaucet(contract.address, DEPOSIT_AMOUNT);

const [coinA] = await waitFor(() => wallet.getVtxos(), "coin A from the faucet");
const [guardCoin] = await waitFor(() => contract.getUtxos(), "guard funding from the faucet");

/** The compiled `pinInputScriptPubKey` spending path: its tapscript leaf and raw arkadeScript bytes. */
const pinInputScriptPubKey = contract.vtxoScript.functionByName("pinInputScriptPubKey")!;

/** Two PSBT inputs: coin A at index 0 (the inspected coin) and the guard at index 1. */
const inputs = [
  {
    ...coinA,
    /** Coin A is a plain wallet coin, spent via its collaborative (forfeit) leaf. */
    tapLeafScript: coinA.forfeitTapLeafScript,
  },
  {
    txid: guardCoin.txid,
    vout: guardCoin.vout,
    value: guardCoin.value,
    /** The guard is spent via the pinInputScriptPubKey covenant leaf. */
    tapLeafScript: pinInputScriptPubKey.tapLeafScript,
    /** The contract's encoded taproot script tree. */
    tapTree: contract.tapTree,
  },
];

/** No output rule here, so the whole value goes back to the wallet in one output. */
const totalValue = BigInt(coinA.value) + BigInt(guardCoin.value);
const outputs = [{ script: walletPkScript, amount: totalValue }];

/**
 * Construct Arkade extension envelope.
 * Only the guard carries a covenant, so there is a single packet entry for its
 * input index; coin A is a plain coin and gets none.
 */
outputs.push(
  Extension.create([
    EmulatorPacket.create([{ vin: 1, script: pinInputScriptPubKey.arkadeScript! }]),
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
 * 5. Submit transaction.
 * Coin A is ours, so we sign both its ark tx input and its checkpoint; the
 * emulator co-signs the guard and checks the covenant before the tx goes through.
 */
const signedArkTx = await identity.sign(arkTx, [PINNED_INPUT_INDEX]);
const signedCheckpoints = await Promise.all(checkpoints.map((c) => identity.sign(c)));
const submitted = await emulator.submitTx(
  base64.encode(signedArkTx.toPSBT()),
  signedCheckpoints.map((c) => base64.encode(c.toPSBT())),
);

/**
 * 6. Extract the finalized transaction's ID
 */
const txid = Transaction.fromPSBT(base64.decode(submitted.signedArkTx)).id;
console.log(
  `Covenant satisfied: input 0 (coin A) matched the pinned scriptPubKey, spent ${inputs.length} input(s): ${EXPLORER_URL}/tx/${txid}`,
);

await wallet.dispose();

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
