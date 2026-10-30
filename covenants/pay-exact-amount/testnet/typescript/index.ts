import { arkade, canSpendOffchain } from "@arkade-os/sdk";

const { Arkade, Script } = arkade;
// `arkade.Program` is not usable as a type in the published typings, so take it from the contract.
type Program = ConstructorParameters<typeof arkade.ArkadeContract>[1];
const DUST = 330n;

const OUTPUT_AMOUNT = 1_000n;

/**
 * A basic covenant contract program, `payExactAmount`, that only lets the operator move funds
 * when output 0 pays exactly OUTPUT_AMOUNT.
 */
const program = {
  version: 1,
  params: [
    { name: "operatorPubkey", type: "pubkey" },
    { name: "outputAmount", type: "int" },
  ],
  functions: {
    payExactAmount: {
      /** Tapscript-level signer requirement: only the operator key. */
      tapscript: { signers: ["$operatorPubkey"] },
      /** Covenant clause executed by the emulator on every spend. */
      arkadeScript: {
        asm: [0, "INSPECTOUTPUTVALUE", "$outputAmount", "EQUAL"],
      },
    },
  },
} as const satisfies Program;

const OPERATOR_URL = "https://mutinynet.arkade.sh";
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh";
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh";

/** 1. Connect to the operator and the covenant co-signer (emulator). */
const ark = await Arkade.connect({
  service: { operatorUrl: OPERATOR_URL, emulatorUrl: EMULATOR_URL },
});

/** 2. Instantiate the contract, binding the program's params to concrete values. */
const contract = ark.contract(program, {
  operatorPubkey: ark.serverKey,
  outputAmount: OUTPUT_AMOUNT,
});

/**
 * 3. Fetch every coin at the contract address that can still be spent offchain. An expired or
 * swept coin has to be renewed instead, and one in the spend would make the operator reject it.
 */
const now = { timestamp: new Date() };
const coins = (await contract.getUtxos()).filter((coin) => canSpendOffchain(coin, now));
const balance = coins.reduce((total, coin) => total + BigInt(coin.value), 0n);

if (balance < OUTPUT_AMOUNT) {
  throw new Error(
    `Fund ${contract.address} with at least ${OUTPUT_AMOUNT - balance} more sats`,
  );
}

/**
 * 4. Spend all coins in one transaction through `payExactAmount`. The builder writes one
 * emulator entry per coin. Every coin's covenant checks the same output 0, so the coins
 * pay OUTPUT_AMOUNT once between them, and the surplus goes back to the contract.
 */
const spend = contract.functions
  .payExactAmount()
  .from(coins)
  .to(contract.pkScript, OUTPUT_AMOUNT);

const change = balance - OUTPUT_AMOUNT;
if (change >= DUST) {
  spend.change(contract.pkScript);
} else if (change > 0n) {
  // Change below dust can't be a VTXO, so it goes to an OP_RETURN output.
  spend.to(Script.encode(["RETURN", contract.vtxoScript.tweakedPublicKey]), change);
}

/**
 * 5. Submit. `payExactAmount` is signed only by the operator, so no client identity is
 * involved: the emulator cosigns and finalizes with the operator.
 */
const { txid } = await spend.send();
console.log(`Spent ${coins.length} contract coin(s): ${EXPLORER_URL}/tx/${txid}`);
