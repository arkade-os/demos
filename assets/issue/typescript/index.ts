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
import Database from "better-sqlite3";
import { EventSource } from "eventsource";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

/** 1. Polyfill EventSource
 * EventSource is used internally by the SDK for settlement events (SSE).
 * It is not available in Node.js by default, so we need to polyfill it.
 */
(globalThis as any).EventSource = EventSource;

/** 2. Create SQL executor */
const createSQLExecutor = (dbPath: string): SQLExecutor => {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return {
    run: async (sql, params) => {
      db.prepare(sql).run(...(params ?? []));
    },
    get: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...(params ?? [])) as T | undefined,
    all: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...(params ?? [])) as T[],
  };
};
const executor = createSQLExecutor("wallet.sqlite");

/** 3. Create identity */
const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
  isMainnet: false,
});

/** 4. Create wallet */
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
    walletRepository: new SQLiteWalletRepository(executor),
    contractRepository: new SQLiteContractRepository(executor),
  },
});

/** 5. Get asset manager */
const manager = wallet.assetManager;

/** 6. Issue control asset */
const { arkTxId: controlIssueTxid, assetId: controlAssetId } =
  await manager.issue({
    amount: 1n,
    metadata: {
      name: "Test Asset (Control)",
      ticker: "ctrl-TA",
      decimals: 0,
      icon: "https://assets.docs.arkadeos.com/orange.png",
    },
  });

console.log(`Issued control asset: ${EXPLORER_URL}/tx/${controlIssueTxid}`);

/** 7. Issue asset with control asset */
const { arkTxId: issueTxid, assetId } = await manager.issue({
  amount: 100n /** 1, adjusted for 2 decimals */,
  controlAssetId,
  metadata: {
    name: "Test Asset",
    ticker: "TA",
    decimals: 2,
    icon: "https://assets.docs.arkadeos.com/purple.png",
  },
});

console.log(`Issued asset with control asset: ${EXPLORER_URL}/tx/${issueTxid}`);

/** 8. Print summary */
console.log({
  controlAssetId,
  controlIssueTxid,
  assetId,
  issueTxid,
});

/** 9. Close the wallet */
await wallet.dispose();
