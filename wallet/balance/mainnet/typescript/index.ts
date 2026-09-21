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
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
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

/** 4. Fetch wallet balance */
const balance = await wallet.getBalance();

/** 5. Parse assets with metadata */
const assetDetails = new Map(
  await Promise.all(
    balance.assets.map(({ assetId }) =>
      wallet.assetManager
        .getAssetDetails(assetId)
        .then((details) => [assetId, details] as const),
    ),
  ),
);

/** 6. Log balance with parsed assets */
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

/** 7. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
