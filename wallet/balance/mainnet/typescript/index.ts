import {
  MnemonicIdentity,
  RestArkProvider,
  RestDelegateProvider,
  Wallet,
} from "@arkade-os/sdk";
import {
  SQLiteContractRepository,
  SQLiteWalletRepository,
  type SQLExecutor,
} from "@arkade-os/sdk/repositories/sqlite";
import Database from "better-sqlite3";
import { EventSource } from "eventsource";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
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

/** 5. Fetch wallet balance */
const balance = await wallet.getBalance();

/** 6. Parse assets with metadata */
const assetDetails = new Map(
  await Promise.all(
    balance.assets.map(({ assetId }) =>
      wallet.assetManager
        .getAssetDetails(assetId)
        .then((details) => [assetId, details] as const),
    ),
  ),
);

/** 7. Log balance with parsed assets */
console.log({
  ...balance,
  assets: balance.assets.map(({ assetId, amount }) => ({
    assetId,
    controlAssetId: assetDetails.get(assetId)?.controlAssetId,
    decimals: assetDetails.get(assetId)?.metadata?.decimals,
    icon: assetDetails.get(assetId)?.metadata?.icon,
    name: assetDetails.get(assetId)?.metadata?.name,
    ticker: assetDetails.get(assetId)?.metadata?.ticker,
    rawAmount: amount,
    parsedAmount: `${amount / 10n ** BigInt(assetDetails.get(assetId)?.metadata?.decimals || 0)} ${assetDetails.get(assetId)?.metadata?.ticker}`,
  })),
});

/** 8. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
