import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";

// `arkade.Program` is not usable as a type in the published typings, so take it from the contract.
type Program = ConstructorParameters<typeof arkade.ArkadeContract>[1];

const TAPROOT_VERSION = 1;

/** A plain contract for coin A: the user and the operator sign, and no covenant applies. */
const ownedProgram = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
  ],
  functions: {
    spend: { tapscript: { signers: ["$userPubkey", "$operatorPubkey"] } },
  },
} as const satisfies Program;

/**
 * A covenant, `pinInputScriptPubKey`, that only lets the user move funds when input 0 is locked to
 * the pinned witness program. A script cannot contain its own hash, so the pinned coin must sit at
 * a different contract.
 */
const guardProgram = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    { name: "pinnedProgram", type: "bytes32" },
  ],
  functions: {
    pinInputScriptPubKey: {
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /** Covenant clause the operator runs on every spend, before it cosigns. */
      arkadeScript: {
        asm: [
          0,
          "INSPECTINPUTSCRIPTPUBKEY",
          TAPROOT_VERSION,
          "EQUALVERIFY",
          "$pinnedProgram",
          "EQUAL",
        ],
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
  pinnedProgram: owned.pkScript.subarray(2),
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
  throw new Error(`Fund ${owned.address} and ${guard.address}`);
}

/**
 * 5. Spend coin A as input 0 and the guard as input 1. Order matters: the covenant reads input 0.
 * Pay each coin back to its own contract, so the demo can run again.
 */
const { txid } = await guard.functions
  .pinInputScriptPubKey()
  .from(coinA, owned.unlock.spend())
  .from(guardCoin)
  .to(owned.pkScript, BigInt(coinA.value))
  .to(guard.pkScript, BigInt(guardCoin.value))
  .send();
console.log(`Input 0 matched the pinned witness program: ${EXPLORER_URL}/tx/${txid}`);
