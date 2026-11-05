import {
  MnemonicIdentity,
  RestArkProvider,
  RestDelegateProvider,
  Wallet,
} from "@arkade-os/sdk";
import {
  type SQLExecutor,
  SQLiteContractRepository,
  SQLiteWalletRepository,
} from "@arkade-os/sdk/repositories/sqlite";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** The note printed by the create demo: `pnpm dev tarkadecash1...` */
const CASH = process.argv[2];

/** A different wallet from the one that created the note */
const SEED_PHRASE =
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;

if (!CASH) {
  throw new Error("Pass the note to claim: pnpm dev tarkadecash1...");
}

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

/** 4. Fetch balance before claiming */
const { available: before } = await wallet.getBalance();

/**
 * 5. Claim note
 *
 * Sweeps every spendable output at the note's address to this wallet,
 * signing with the key the note carries. Outputs the operator already swept
 * are handed to the wallet's recovery instead, and the rest are reported.
 * Safe to re-run: an interrupted claim completes on the next call.
 */
const { swept, recovering, unclaimed } = await wallet.claimCash(CASH);

console.log("Claimed note:", {
  /** Arrived in this wallet now */
  swept,
  /** Arrives once the wallet's recovery settles it */
  recovering: recovering.amount,
  /** Left behind, with a reason per output (e.g. already-spent) */
  unclaimed: unclaimed.vtxos,
});

/** 6. Fetch balance after claiming */
const { available: after } = await wallet.getBalance();

console.log(`Available balance: ${before} -> ${after} sats`);

/** 7. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
