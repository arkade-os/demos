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

/** 4. Find a coin without assets that can be spent offchain and clears the minimum. */
const now = { timestamp: new Date() };
const coin = (await contract.getUtxos()).find(
  (candidate) =>
    canSpendOffchain(candidate, now) &&
    !candidate.assets?.length &&
    BigInt(candidate.value) >= MIN_AMOUNT,
);

if (!coin) {
  throw new Error(`Fund ${contract.address} with at least ${MIN_AMOUNT} sats`);
}

/** 5. Spend the coin back to the contract, so the demo can run again. */
const { txid } = await contract.functions
  .requireMinInputValue()
  .from(coin)
  .to(contract.pkScript, BigInt(coin.value))
  .send();
console.log(`Input 0 cleared the ${MIN_AMOUNT}-sat minimum: ${EXPLORER_URL}/tx/${txid}`);
