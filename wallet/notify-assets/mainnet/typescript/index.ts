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
import Database from "better-sqlite3";
import { EventSource } from "eventsource";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const ASSET_ID =
  "f3d43225e69b4037a4970b9e729f716aac3cb3cf771fd9ada628904fadafec490000" as const;
const DELEGATE_URL = "https://delegate.arkade.money" as const;

/** 1. Polyfill EventSource
 * EventSource is used internally by the SDK for settlement events (SSE).
 * It is not available in Node.js by default, so we need to polyfill it.
 */
(globalThis as any).EventSource = EventSource;

/** 2. Initialize SQLite database */
const initDB = (dbPath: string) => {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  const sqlExecutor = {
    run: async (sql, params) => {
      db.prepare(sql).run(...(params ?? []));
    },
    get: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...(params ?? [])) as T | undefined,
    all: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...(params ?? [])) as T[],
  } as const satisfies SQLExecutor;
  const closeDB = () => db.close();
  return { sqlExecutor, closeDB };
};
const { sqlExecutor, closeDB } = initDB("wallet.sqlite");

/** 3. Create identity */
const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE);

/** 4. Create wallet */
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

/** 5. Get initial output set */
const outputs = await wallet.getVtxos({
  /** Include recoverable (non-spendable) outputs */
  withRecoverable: true,
});

/** 6. Flat map into asset 'bundles' (multiple assets can live on the same output) */
const extractAssetBundles = (outputs: ExtendedVirtualCoin[]) =>
  outputs.flatMap(({ txid, vout, virtualStatus: { state: status }, assets }) =>
    (assets || [])
      /** Filter only matching assets */
      .filter((asset) => asset.assetId === ASSET_ID)
      .map((asset) => ({
        txid,
        vout,
        status,
        ...asset,
      })),
  );

console.log("Initial asset bundles:", extractAssetBundles(outputs));

/** 7. Subscribe for incoming funds */
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

/** 8. Graceful shutdown */
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
