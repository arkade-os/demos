import {
  type ExtendedVirtualCoin,
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

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const ASSET_ID =
  "0abcbc23c60028511880807dfe42aa16de88bd56df210a0b9135262d5d3959510000" as const;
const DELEGATE_URL = "https://delegate.arkade.money" as const;

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
const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE);

/** 3. Create wallet */
const wallet = await Wallet.create({
  identity,
  arkProvider: new RestArkProvider(),
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

/** 4. Get initial output set */
const outputs = await wallet.getVtxos({
  /** Include recoverable (non-spendable) outputs */
  withRecoverable: true,
});

/** 5. Flat map into asset 'bundles' (multiple assets can live on the same output) */
const extractAssetBundles = (outputs: ExtendedVirtualCoin[]) =>
  outputs.flatMap(({ txid, vout, isPreconfirmed, isSwept, isSpent, assets }) =>
    (assets || [])
      /** Filter only matching assets */
      .filter((asset) => asset.assetId === ASSET_ID)
      .map((asset) => ({
        txid,
        vout,
        isPreconfirmed,
        isSwept,
        isSpent,
        ...asset,
      })),
  );

console.log("Initial asset bundles:", extractAssetBundles(outputs));

/** 6. Subscribe for incoming funds */
const stopNotifying = await wallet.notifyIncomingFunds(async (event) => {
  /** Ignore boarding inputs */
  if (event.type === "utxo") return;
  const { spentVtxos, newVtxos } = event;
  /** Filter both spent + new outputs into bundles */
  if (spentVtxos.length) {
    console.log("Spent bundles:", extractAssetBundles(spentVtxos));
  }
  if (newVtxos.length) {
    console.log("New bundles:", extractAssetBundles(newVtxos));
  }
});

console.log("Listening for incoming deposits...");
console.log("Filtering for asset ID:", ASSET_ID);
console.log("Deposit address:", await wallet.getAddress());
console.log("(press Enter to close)");

/** 7. Graceful shutdown */
if (process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.once("data", async () => {
    try {
      console.log("Stopping notifications...");
      stopNotifying();

      console.log("Disposing wallet...");
      await wallet.dispose();

      console.log("Closing database...");
      closeDB();

      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown", error);
      process.exit(1);
    }
  });
}
