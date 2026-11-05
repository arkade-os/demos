import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";

// `arkade.Program` is not usable as a type in the published typings, so take it from the contract.
type Program = ConstructorParameters<typeof arkade.ArkadeContract>[1];

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

/** 4. Fetch two coins without assets that clear the minimum and can be spent offchain. */
const now = { timestamp: new Date() };
const coins = (await contract.getUtxos())
  .filter(
    (coin) =>
      canSpendOffchain(coin, now) &&
      !coin.assets?.length &&
      BigInt(coin.value) >= MIN_AMOUNT,
  )
  .slice(0, 2);

if (coins.length < 2) {
  throw new Error(`Send two payments of at least ${MIN_AMOUNT} sats to ${contract.address}`);
}

/**
 * 5. Spend both coins through the same path. The operator runs the covenant once per input, and
 * each run checks its own coin. Pay each amount back to the contract, so the demo can run again.
 */
const { txid } = await contract.functions
  .selfReferencingInputIndex()
  .from(coins)
  .to(coins.map((coin) => ({ script: contract.pkScript, amount: BigInt(coin.value) })))
  .send();
console.log(`Each input checked its own value: ${EXPLORER_URL}/tx/${txid}`);
