import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";

// `arkade.Program` can't be used as a type yet (arkade-os/ts-sdk#856), so take it from the contract.
type Program = arkade.ArkadeContract["program"];

const MIN_AMOUNT = 1_000n;

/**
 * A covenant, `selfReferencingInputIndex`, that only lets the user move funds when the coin it
 * guards is worth at least MIN_AMOUNT. It reads its own input index with PUSHCURRENTINPUTINDEX
 * instead of a fixed number, so one rule guards a coin at any position in the input list.
 */
const program = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    { name: "minAmount", type: "int" },
    /** A reserved name: `ark.contract` binds it to the operator's exit delay. */
    { name: "SERVER_EXIT_DELAY", type: "int" },
  ],
  functions: {
    selfReferencingInputIndex: {
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /** Covenant clause the operator runs on every spend, before it cosigns. */
      arkadeScript: {
        asm: ["PUSHCURRENTINPUTINDEX", "INSPECTINPUTVALUE", "$minAmount", "GREATERTHANOREQUAL"],
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
  minAmount: MIN_AMOUNT,
});

/** 4. Find three coins without assets that can be spent offchain: two clear the minimum. */
const now = { timestamp: new Date() };
const available = (await contract.getUtxos()).filter(
  (coin) => canSpendOffchain(coin, now) && !coin.assets?.length,
);
const coins = available.filter((coin) => BigInt(coin.value) >= MIN_AMOUNT).slice(0, 2);
const smallCoin = available.find((coin) => BigInt(coin.value) < MIN_AMOUNT);

if (coins.length < 2 || !smallCoin) {
  throw new Error(
    `Send three payments to ${contract.address}: ${MIN_AMOUNT} sats twice and 500 sats`,
  );
}

/** Each spend pays every amount back to the contract, so the demo can run again. */
const payBack = (spent: typeof coins) =>
  spent.map((coin) => ({ script: contract.pkScript, amount: BigInt(coin.value) }));

/**
 * 5. Try to spend a good coin as input 0 and the small coin as input 1. The run for input 1 checks
 * its own coin, so the operator refuses the spend. The small coin stays for the next run.
 */
const mixedCoins = [coins[0], smallCoin];
await contract.functions
  .selfReferencingInputIndex()
  .from(mixedCoins)
  .to(payBack(mixedCoins))
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

/**
 * 6. Spend both good coins through the same path. The operator runs the covenant once per input,
 * and each run checks its own coin. This spend differs from the refused one only in its coins, so
 * the failure comes from the covenant.
 */
const { txid } = await contract.functions
  .selfReferencingInputIndex()
  .from(coins)
  .to(payBack(coins))
  .send();
console.log(`Each input checked its own value: ${EXPLORER_URL}/tx/${txid}`);
