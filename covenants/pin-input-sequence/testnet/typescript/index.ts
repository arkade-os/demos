import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";

// `arkade.Program` is not usable as a type in the published typings, so take it from the contract.
type Program = ConstructorParameters<typeof arkade.ArkadeContract>[1];

/** Arkade transaction inputs use Bitcoin's final sequence unless the spend sets a locktime. */
const FINAL_SEQUENCE = 0xffffffffn;

/**
 * A covenant, `pinInputSequence`, that only lets the user move funds when input 0 carries the
 * pinned nSequence value.
 */
const program = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    { name: "sequence", type: "int" },
  ],
  functions: {
    pinInputSequence: {
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /** Covenant clause the operator runs on every spend, before it cosigns. */
      arkadeScript: {
        asm: [0, "INSPECTINPUTSEQUENCE", "$sequence", "EQUAL"],
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

/** 2. Connect to the operator. `emulatorUrl` is where it runs covenant scripts. */
const ark = await Arkade.connect({
  service: { operatorUrl: OPERATOR_URL, emulatorUrl: EMULATOR_URL },
  identity,
});

/** 3. Instantiate the contract, binding the program's params to concrete values. */
const contract = ark.contract(program, {
  userPubkey: await identity.xOnlyPublicKey(),
  operatorPubkey: ark.serverKey,
  sequence: FINAL_SEQUENCE,
});

/** 4. Find a coin without assets that can be spent offchain. */
const now = { timestamp: new Date() };
const coin = (await contract.getUtxos()).find(
  (candidate) => canSpendOffchain(candidate, now) && !candidate.assets?.length,
);

if (!coin) {
  throw new Error(`Fund ${contract.address} to run this demo`);
}

/** 5. Spend the coin back to the contract, so the demo can run again. */
const { txid } = await contract.functions
  .pinInputSequence()
  .from(coin)
  .to(contract.pkScript, BigInt(coin.value))
  .send();
console.log(`Input 0 carried the pinned sequence: ${EXPLORER_URL}/tx/${txid}`);
