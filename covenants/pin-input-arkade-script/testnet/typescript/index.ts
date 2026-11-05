import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";

// `arkade.Program` can't be used as a type yet (arkade-os/ts-sdk#856), so take it from the contract.
type Program = arkade.ArkadeContract["program"];

/**
 * A covenant, `pinInputArkadeScript`, that only lets the user move funds when input 0 and input 1
 * carry the same Arkade Script. It constrains the coins spent with it, not its own future outputs,
 * so it is not a recursive covenant.
 */
const program = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    /** A reserved name: `ark.contract` binds it to the operator's exit delay. */
    { name: "SERVER_EXIT_DELAY", type: "int" },
  ],
  functions: {
    pinInputArkadeScript: {
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /** Covenant clause the operator runs on every spend, before it cosigns. */
      arkadeScript: {
        asm: [0, "INSPECTINPUTARKADESCRIPTHASH", 1, "INSPECTINPUTARKADESCRIPTHASH", "EQUAL"],
      },
    },
    /**
     * A second path with a different Arkade Script, so step 5 can show a refused spend. Its script
     * always passes, so a real contract would not include it.
     */
    differentScript: {
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      arkadeScript: { asm: [1] },
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

/** 3. Instantiate the contract, binding the program's params to concrete values. */
const contract = ark.contract(program, {
  userPubkey: await identity.xOnlyPublicKey(),
  operatorPubkey: ark.serverKey,
});

/** 4. Fetch two coins without assets that can be spent offchain. */
const now = { timestamp: new Date() };
const coins = (await contract.getUtxos())
  .filter((coin) => canSpendOffchain(coin, now) && !coin.assets?.length)
  .slice(0, 2);

if (coins.length < 2) {
  throw new Error(`Send two payments of at least 330 sats to ${contract.address}`);
}

/** Each spend pays every amount back to the contract, so the demo can run again. */
const payBack = coins.map((coin) => ({ script: contract.pkScript, amount: BigInt(coin.value) }));

/**
 * 5. Try a spend whose two inputs carry different scripts. The operator runs the covenant and
 * refuses it. The same coins pass in step 6, so the failure comes from the covenant.
 */
await contract.functions
  .pinInputArkadeScript()
  .from(coins[0], contract.unlock.differentScript())
  .from(coins[1])
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

/** 6. Spend both coins through the same path, so both inputs carry the same script. */
const { txid } = await contract.functions
  .pinInputArkadeScript()
  .from(coins)
  .to(payBack)
  .send();
console.log(`Inputs 0 and 1 carried the same Arkade Script: ${EXPLORER_URL}/tx/${txid}`);
