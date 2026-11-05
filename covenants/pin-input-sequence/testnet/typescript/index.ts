import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";

// `arkade.Program` can't be used as a type yet (arkade-os/ts-sdk#856), so take it from the contract.
type Program = arkade.ArkadeContract["program"];

/** Arkade transaction inputs use Bitcoin's final sequence unless the spend sets a locktime. */
const FINAL_SEQUENCE = 0xffffffffn;

/**
 * The locktime of the second path, which can be any past Unix time. It can't be a block height:
 * this operator refuses every path of a contract that has a block-height timelock.
 */
const PAST_TIME = 1_700_000_000n;

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
    /** A reserved name: `ark.contract` binds it to the operator's exit delay. */
    { name: "SERVER_EXIT_DELAY", type: "int" },
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
    /**
     * The same covenant on a path with an absolute timelock, so step 5 can show a refused spend.
     * Its spends set a locktime, so their inputs don't carry the final sequence.
     */
    pinInputSequenceWithLocktime: {
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"], cltv: PAST_TIME },
      arkadeScript: {
        asm: [0, "INSPECTINPUTSEQUENCE", "$sequence", "EQUAL"],
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
  throw new Error(`Send at least 330 sats to ${contract.address}`);
}

/**
 * 5. Try to spend the coin through the path with a locktime. Input 0 no longer carries the pinned
 * sequence, so the operator refuses the spend. The error doesn't name the cause: the evidence is
 * that the same coin passes in step 6 through the path without a locktime.
 */
await contract.functions
  .pinInputSequenceWithLocktime()
  .from(coin)
  .to(contract.pkScript, BigInt(coin.value))
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

/** 6. Spend the coin back to the contract, so the demo can run again. */
const { txid } = await contract.functions
  .pinInputSequence()
  .from(coin)
  .to(contract.pkScript, BigInt(coin.value))
  .send();
console.log(`Input 0 carried the pinned sequence: ${EXPLORER_URL}/tx/${txid}`);
