import {
  Arkade,
  arkade,
  canSpendOffchain,
  MnemonicIdentity,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

// `arkade.Program` can't be used as a type yet (arkade-os/ts-sdk#856), so take it from the contract.
type Program = arkade.ArkadeContract["program"];

/** A plain contract for coin A: the user and the operator sign, and no covenant applies. */
const ownedProgram = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    /** A reserved name: `ark.contract` binds it to the operator's exit delay. */
    { name: "SERVER_EXIT_DELAY", type: "int" },
  ],
  functions: {
    spend: { tapscript: { signers: ["$userPubkey", "$operatorPubkey"] } },
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

/**
 * A covenant, `requireInputOutpoint`, that only lets the user move funds when input 0 spends one
 * exact outpoint, chosen before the guard is funded.
 */
const guardProgram = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    { name: "requiredTxid", type: "bytes32" },
    { name: "requiredVout", type: "int" },
    /** A reserved name: `ark.contract` binds it to the operator's exit delay. */
    { name: "SERVER_EXIT_DELAY", type: "int" },
  ],
  functions: {
    requireInputOutpoint: {
      /** Tapscript-level signers: the user and the operator. */
      tapscript: { signers: ["$userPubkey", "$operatorPubkey"] },
      /**
       * Covenant clause the operator runs on every spend, before it cosigns.
       * INSPECTINPUTOUTPOINT pushes the txid, then the vout on top.
       */
      arkadeScript: {
        asm: [
          0,
          "INSPECTINPUTOUTPOINT",
          "$requiredVout",
          "EQUALVERIFY",
          "$requiredTxid",
          "EQUAL",
        ],
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

/** 3. Instantiate the plain contract, then fetch its coins without assets. */
const keys = {
  userPubkey: await identity.xOnlyPublicKey(),
  operatorPubkey: ark.serverKey,
};
const owned = ark.contract(ownedProgram, keys);

const now = { timestamp: new Date() };
const spendable = (coins: Awaited<ReturnType<typeof owned.getUtxos>>) =>
  coins.filter((coin) => canSpendOffchain(coin, now) && !coin.assets?.length);
const [coinA, guardFunds] = spendable(await owned.getUtxos());

if (!coinA) {
  throw new Error(`Send two payments of at least 330 sats to ${owned.address}`);
}

/**
 * 4. Find the required outpoint. Input 0 of an Arkade transaction spends the checkpoint of a coin,
 * not the coin, so INSPECTINPUTOUTPOINT sees the checkpoint. The checkpoint commits only to the
 * coin, its spending path and the operator's checkpoint script. The other inputs and outputs of
 * the spend cannot change it, so a trial build gives the final txid.
 */
const { checkpoints } = await owned.functions
  .spend()
  .from(coinA)
  .to(owned.pkScript, BigInt(coinA.value))
  .build();

/** 5. Instantiate the guard. The covenant reads the txid in internal (reversed) byte order. */
const guard = ark.contract(guardProgram, {
  ...keys,
  requiredTxid: hex.decode(checkpoints[0].id).reverse(),
  /** A checkpoint has one output. */
  requiredVout: 0,
});

/**
 * 6. Fund the guard from the second coin. A run that stopped after this step left a coin at the
 * guard. Offchain, that coin can only move alongside coin A, so reuse it.
 */
const fundGuard = async () => {
  if (!guardFunds) {
    throw new Error(`Send another payment of at least 330 sats to ${owned.address}`);
  }
  const { txid } = await owned.functions
    .spend()
    .from(guardFunds)
    .to(guard.pkScript, BigInt(guardFunds.value))
    .send();
  return { txid, vout: 0, value: guardFunds.value };
};
const [leftover] = spendable(await guard.getUtxos());
const guardCoin = leftover ?? (await fundGuard());

/** Each spend pays both amounts back to the plain contract, so the demo can run again. */
const payBack = [coinA, guardCoin].map((coin) => ({
  script: owned.pkScript,
  amount: BigInt(coin.value),
}));

/**
 * 7. Try the spend with the guard as input 0. That input spends a different outpoint, so the
 * operator refuses it. The error doesn't name the cause: the evidence is that the same coins pass
 * in step 8.
 */
await guard.functions
  .requireInputOutpoint()
  .from(guardCoin)
  .from(coinA, owned.unlock.spend())
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

/** 8. Spend coin A as input 0 and the guard as input 1. */
const { txid } = await guard.functions
  .requireInputOutpoint()
  .from(coinA, owned.unlock.spend())
  .from(guardCoin)
  .to(payBack)
  .send();
console.log(`Input 0 spent the required outpoint: ${EXPLORER_URL}/tx/${txid}`);
