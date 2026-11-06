import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";

// `arkade.Program` can't be used as a type yet (arkade-os/ts-sdk#856), so take it from the contract.
type Program = arkade.ArkadeContract["program"];

const TAPROOT_VERSION = 1;

/** A plain contract for coin A: the user and the operator sign, and no covenant applies. */
const ownedProgram = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    /** A reserved name: `ark.contract` binds it to the operator's exit delay. */
    { name: "SERVER_EXIT_DELAY", type: "int" },
  ],
  functions: {
    spend: { tapscript: { signers: ["$userPubkey", "$operatorPubkey"] } },
    /**
     * The exit path: if the operator is unavailable, the user alone can claim the coin onchain
     * after the exit delay. See https://docs.arkadeos.com/vaults/exit.
     */
    unilateral: {
      tapscript: {
        signers: ["$userPubkey"],
        csv: { type: "sequence", value: "$SERVER_EXIT_DELAY" },
      },
    },
  },
} as const satisfies Program;

/**
 * A covenant, `requireInputScriptPubKey`, that only lets the user move funds when input 0 is locked
 * to the required witness program. A script cannot contain its own hash, so input 0 must spend a
 * coin at a different contract.
 */
const guardProgram = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    { name: "requiredProgram", type: "bytes32" },
    /** A reserved name: `ark.contract` binds it to the operator's exit delay. */
    { name: "SERVER_EXIT_DELAY", type: "int" },
  ],
  functions: {
    requireInputScriptPubKey: {
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /**
       * Covenant clause the operator runs on every spend, before it cosigns.
       * INSPECTINPUTSCRIPTPUBKEY pushes the witness program, then the version on top.
       */
      arkadeScript: {
        asm: [
          0,
          "INSPECTINPUTSCRIPTPUBKEY",
          TAPROOT_VERSION,
          "EQUALVERIFY",
          "$requiredProgram",
          "EQUAL",
        ],
      },
    },
    /**
     * The exit path: if the operator is unavailable, the user alone can claim the coin onchain
     * after the exit delay. See https://docs.arkadeos.com/vaults/exit.
     */
    unilateral: {
      tapscript: {
        signers: ["$userPubkey"],
        csv: { type: "sequence", value: "$SERVER_EXIT_DELAY" },
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

/** 3. Instantiate both contracts. The witness program is the pkScript without its 2-byte prefix. */
const keys = {
  userPubkey: await identity.xOnlyPublicKey(),
  operatorPubkey: ark.serverKey,
};
const owned = ark.contract(ownedProgram, keys);
const guard = ark.contract(guardProgram, {
  ...keys,
  requiredProgram: owned.pkScript.subarray(2),
});

/** 4. Fetch one coin without assets from each contract that can be spent offchain. */
const now = { timestamp: new Date() };
const spendable = async (contract: typeof owned | typeof guard) =>
  (await contract.getUtxos()).find(
    (coin) => canSpendOffchain(coin, now) && !coin.assets?.length,
  );
const coinA = await spendable(owned);
const guardCoin = await spendable(guard);

if (!coinA || !guardCoin) {
  throw new Error(`Send at least 330 sats to ${owned.address} and to ${guard.address}`);
}

/** Each spend pays each coin back to its own contract, so the demo can run again. */
const payBack = [
  { script: owned.pkScript, amount: BigInt(coinA.value) },
  { script: guard.pkScript, amount: BigInt(guardCoin.value) },
];

/**
 * 5. Try the spend with the guard as input 0. Order matters: the covenant reads input 0, so the
 * operator refuses this spend. The error doesn't name the cause: the evidence is that the same
 * coins pass in step 6.
 */
await guard.functions
  .requireInputScriptPubKey()
  .from(guardCoin)
  .from(coinA, owned.unlock.spend())
  .to(payBack)
  .send()
  .then(
    () => {
      throw new Error("The covenant did not refuse this spend");
    },
    (error) => {
      if (!error.message.includes("Failed to submit tx to emulator")) throw error;
      console.log(`Refused, as expected: ${error.message}`);
    },
  );

/** 6. Spend coin A as input 0 and the guard as input 1. */
const { txid } = await guard.functions
  .requireInputScriptPubKey()
  .from(coinA, owned.unlock.spend())
  .from(guardCoin)
  .to(payBack)
  .send();
console.log(`Input 0 matched the required witness program: ${EXPLORER_URL}/tx/${txid}`);
