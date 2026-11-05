import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";
import { RawWitness } from "@scure/btc-signer";

// `arkade.Program` can't be used as a type yet (arkade-os/ts-sdk#856), so take it from the contract.
type Program = arkade.ArkadeContract["program"];

/** The hashlock secret. A real one is random and private. */
const PREIMAGE = new TextEncoder().encode("open-sesame");
const HASH = new Uint8Array(await crypto.subtle.digest("SHA-256", PREIMAGE));
/** The hash the covenant pins. `RawWitness` is the encoding the SDK puts in the spend. */
const WITNESS_HASH = arkade.arkadeWitnessHash(RawWitness.encode([PREIMAGE]));

/**
 * One contract with two spending paths:
 *  - `hashlock` spends a coin by revealing the preimage in its Arkade witness.
 *  - `pinInputArkadeWitness` only lets the user move funds when the Arkade witness of input 0
 *    hashes to the pinned value, so input 0 must reveal exactly this preimage.
 */
const program = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    { name: "hash", type: "bytes32" },
    { name: "witnessHash", type: "bytes32" },
    /** A reserved name: `ark.contract` binds it to the operator's exit delay. */
    { name: "SERVER_EXIT_DELAY", type: "int" },
  ],
  functions: {
    hashlock: {
      inputs: [{ name: "preimage", type: "bytes" }],
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /** Consumes the preimage from its witness: its SHA-256 must equal the committed hash. */
      arkadeScript: { asm: ["SHA256", "$hash", "EQUAL"], witness: ["preimage"] },
    },
    pinInputArkadeWitness: {
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /** Reads the witness hash of input 0 and requires it to match the pinned value. */
      arkadeScript: {
        asm: [0, "INSPECTINPUTARKADEWITNESSHASH", "$witnessHash", "EQUAL"],
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
  hash: HASH,
  witnessHash: WITNESS_HASH,
});

/** 4. Fetch two coins without assets that can be spent offchain: one for each path. */
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
 * 5. Try to spend both coins through the pinning path. Input 0 then has no Arkade witness, so the
 * operator refuses the spend. The error doesn't name the cause: the evidence is that the same
 * coins pass in step 6.
 */
await contract.functions
  .pinInputArkadeWitness()
  .from(coins)
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

/**
 * 6. Spend the first coin through `hashlock` as input 0, and the second through the pinning path
 * as input 1. Order matters: the covenant reads input 0.
 */
const { txid } = await contract.functions
  .pinInputArkadeWitness()
  .from(coins[0], contract.unlock.hashlock(PREIMAGE))
  .from(coins[1])
  .to(payBack)
  .send();
console.log(`Input 1 pinned the witness of input 0: ${EXPLORER_URL}/tx/${txid}`);
