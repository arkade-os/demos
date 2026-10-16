import {
  ArkadeCash,
  ArkadeCashCreateError,
  MnemonicIdentity,
  networks,
  RestArkProvider,
  RestDelegateProvider,
  Wallet,
} from "@arkade-os/sdk";
import {
  type SQLExecutor,
  SQLiteContractRepository,
  SQLiteWalletRepository,
} from "@arkade-os/sdk/repositories/sqlite";
import { hex } from "@scure/base";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** How many sats the note carries (at least the dust amount) */
const CASH_AMOUNT = 1_000 as const;

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const NETWORK = networks.mutinynet;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

/** 1. Initialize SQLite database */
const initDB = (dbPath: string) => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  const sqlExecutor = {
    run: async (sql, params) => {
      db.prepare(sql).run(...((params ?? []) as SQLInputValue[]));
    },
    get: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...((params ?? []) as SQLInputValue[])) as
        | T
        | undefined,
    all: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...((params ?? []) as SQLInputValue[])) as T[],
  } as const satisfies SQLExecutor;
  const closeDB = () => db.close();
  return { sqlExecutor, closeDB };
};
const { sqlExecutor, closeDB } = initDB("wallet.sqlite");

/** 2. Create identity */
const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
  isMainnet: false,
});

/** 3. Create wallet */
const wallet = await Wallet.create({
  identity,
  arkProvider: new RestArkProvider(OPERATOR_URL),
  delegateProvider: new RestDelegateProvider(DELEGATE_URL),
  /**
   * Explicitly disable settlement
   * Recommended to leave undefined for production
   */
  settlementConfig: false,
  /**
   * Explicitly disable address rotation
   * Recommended to use 'hd' for production
   */
  walletMode: "static",
  /**
   * Explicitly use SQLite storage
   * Defaults to IndexedDB if undefined
   */
  storage: {
    walletRepository: new SQLiteWalletRepository(sqlExecutor),
    contractRepository: new SQLiteContractRepository(sqlExecutor),
  },
});

/** 4. Check available balance */
const { available } = await wallet.getBalance();

if (available < CASH_AMOUNT) {
  throw new Error(`Wallet balance must be at least ${CASH_AMOUNT}`, {
    cause: await wallet.getAddress(),
  });
}

/**
 * 5. Create note
 *
 * Generates a fresh key, sends CASH_AMOUNT to an ordinary output locked to
 * that key, and returns the key (plus the contract parameters) as a string.
 * Whoever holds the string can claim the funds: no address exchange needed.
 */
const cash = await wallet.createCash(CASH_AMOUNT).catch((error) => {
  /** The send may have landed anyway: keep the note, claiming recovers it */
  if (error instanceof ArkadeCashCreateError) {
    console.error("Send failed, keep this note to recover:", error.cash);
  }
  throw error;
});

/** 6. Decode note */
const note = ArkadeCash.fromString(cash);

console.log("Created note:", {
  publicKey: hex.encode(note.publicKey),
  address: note.address(NETWORK.hrp).encode(),
  exitTimelock: note.csvTimelock,
});

/** 7. Find the output the note controls */
const { vtxos: outputs } = await wallet.indexerProvider.getVtxos({
  scripts: [hex.encode(note.vtxoScript.pkScript)],
});

for (const { txid, vout, value } of outputs) {
  console.log(`Note output: ${value} sats at ${EXPLORER_URL}/tx/${txid}`, {
    vout,
  });
}

/**
 * 8. Hand over note
 *
 * It's a bearer instrument, so treat it like cash: send it privately, and
 * claim it promptly. Unclaimed past its batch expiry, the operator sweeps it
 * and it can only be recovered through a settlement.
 */
console.log(`\nNote: ${cash}\n`);
console.log(
  `Claim it with: (cd ../../../claim/testnet/typescript && pnpm dev ${cash})`,
);

/** 9. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
