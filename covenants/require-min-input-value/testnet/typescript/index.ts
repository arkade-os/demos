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
 * A covenant, `requireMinInputValue`, that only lets the user move funds when input 0 is worth at
 * least MIN_AMOUNT.
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
    requireMinInputValue: {
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /** Covenant clause the operator runs on every spend, before it cosigns. */
      arkadeScript: {
        asm: [0, "INSPECTINPUTVALUE", "$minAmount", "GREATERTHANOREQUAL"],
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

/** 4. Find two coins without assets that can be spent offchain: one on each side of the minimum. */
const now = { timestamp: new Date() };
const coins = (await contract.getUtxos()).filter(
  (candidate) => canSpendOffchain(candidate, now) && !candidate.assets?.length,
);
const coin = coins.find((candidate) => BigInt(candidate.value) >= MIN_AMOUNT);
const smallCoin = coins.find((candidate) => BigInt(candidate.value) < MIN_AMOUNT);

if (!coin || !smallCoin) {
  throw new Error(`Send two payments to ${contract.address}: ${MIN_AMOUNT} sats and 500 sats`);
}

/**
 * 5. Try to spend the small coin. The operator runs the covenant and refuses the spend, so the
 * coin stays at the contract for the next run.
 */
await contract.functions
  .requireMinInputValue()
  .from(smallCoin)
  .to(contract.pkScript, BigInt(smallCoin.value))
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
 * 6. Spend the other coin back to the contract, so the demo can run again. This spend differs from
 * the refused one only in the coin, so the failure comes from the covenant.
 */
const { txid } = await contract.functions
  .requireMinInputValue()
  .from(coin)
  .to(contract.pkScript, BigInt(coin.value))
  .send();
console.log(`Input 0 cleared the ${MIN_AMOUNT}-sat minimum: ${EXPLORER_URL}/tx/${txid}`);
