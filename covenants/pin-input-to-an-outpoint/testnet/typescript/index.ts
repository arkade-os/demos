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
 * A covenant, `pinInput`, that only lets the user move funds when input 0 spends one exact
 * outpoint, chosen before the guard is funded.
 */
const guardProgram = {
  version: 1,
  /** Typed constructor params: every `$name` below must be declared here */
  params: [
    { name: "userPubkey", type: "pubkey" },
    { name: "operatorPubkey", type: "pubkey" },
    { name: "pinnedTxid", type: "bytes32" },
    { name: "pinnedVout", type: "int" },
    /** A reserved name: `ark.contract` binds it to the operator's exit delay. */
    { name: "SERVER_EXIT_DELAY", type: "int" },
  ],
  functions: {
    pinInput: {
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
          "$pinnedVout",
          "EQUALVERIFY",
          "$pinnedTxid",
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

/** 3. Instantiate the plain contract, then fetch two coins without assets from it. */
const keys = {
  userPubkey: await identity.xOnlyPublicKey(),
  operatorPubkey: ark.serverKey,
};
const owned = ark.contract(ownedProgram, keys);

const now = { timestamp: new Date() };
const coins = (await owned.getUtxos()).filter(
  (coin) => canSpendOffchain(coin, now) && !coin.assets?.length,
);

if (coins.length < 2) {
  throw new Error(`Send two payments to ${owned.address}`);
}
const [coinA, guardFunds] = coins;

/**
 * 4. Find the outpoint to pin. Input 0 of an Arkade transaction spends the checkpoint of a coin,
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
  pinnedTxid: hex.decode(checkpoints[0].id).reverse(),
  /** A checkpoint has one output. */
  pinnedVout: 0,
});

/** 6. Fund the guard from the second coin. */
const funding = await owned.functions
  .spend()
  .from(guardFunds)
  .to(guard.pkScript, BigInt(guardFunds.value))
  .send();
const guardCoin = { txid: funding.txid, vout: 0, value: guardFunds.value };

/**
 * 7. Spend coin A as input 0 and the guard as input 1. Pay both amounts back to the plain
 * contract, so the demo can run again.
 */
const { txid } = await guard.functions
  .pinInput()
  .from(coinA, owned.unlock.spend())
  .from(guardCoin)
  .to(owned.pkScript, BigInt(coinA.value))
  .to(owned.pkScript, BigInt(guardFunds.value))
  .send();
console.log(`Input 0 spent the pinned outpoint: ${EXPLORER_URL}/tx/${txid}`);
