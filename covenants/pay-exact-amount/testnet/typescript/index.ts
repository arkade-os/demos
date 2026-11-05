import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";

// `arkade.Program` can't be used as a type yet (arkade-os/ts-sdk#856), so take it from the contract.
type Program = arkade.ArkadeContract["program"];
const DUST = 330n;

const OUTPUT_AMOUNT = 1_000n;

/**
 * A basic covenant contract program, `payExactAmount`, that only lets the user move funds
 * when output 0 pays exactly OUTPUT_AMOUNT.
 */
const program = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    { name: "outputAmount", type: "int" },
  ],
  functions: {
    payExactAmount: {
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /** Covenant clause the operator runs on every spend, before it cosigns. */
      arkadeScript: {
        asm: [0, "INSPECTOUTPUTVALUE", "$outputAmount", "EQUAL"],
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
  outputAmount: OUTPUT_AMOUNT,
});

/**
 * 4. Fetch every coin at the contract address that can still be spent offchain. An expired or
 * swept coin has to be renewed instead, and one in the spend would make the operator reject it.
 * Anyone can send an asset coin here too; this spend routes no assets, so it leaves those out.
 */
const now = { timestamp: new Date() };
const coins = (await contract.getUtxos()).filter(
  (coin) => canSpendOffchain(coin, now) && !coin.assets?.length,
);
const balance = coins.reduce((total, coin) => total + BigInt(coin.value), 0n);
const change = balance - OUTPUT_AMOUNT;

if (change < 0n) {
  throw new Error(
    `Fund ${contract.address} with at least ${-change} more sats`,
  );
}

/**
 * Change below dust could only go to an OP_RETURN output, and this contract could never spend
 * that coin. Stop here, before those sats get stuck.
 */
if (change > 0n && change < DUST) {
  throw new Error(
    `Change of ${change} sats is below dust: fund ${contract.address} with at least ${DUST} more sats`,
  );
}

/**
 * 5. Spend all coins in one transaction through `payExactAmount`. Every coin's covenant checks
 * the same output 0, so the coins pay OUTPUT_AMOUNT once between them, and any surplus goes
 * back to the contract. The SDK signs for the user, and the operator runs the covenant and
 * cosigns.
 */
const { txid } = await contract.functions
  .payExactAmount()
  .from(coins)
  .to(contract.pkScript, OUTPUT_AMOUNT)
  .change(contract.pkScript)
  .send();
console.log(`Spent ${coins.length} contract coin(s): ${EXPLORER_URL}/tx/${txid}`);
