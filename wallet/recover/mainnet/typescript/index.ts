import {
  MnemonicIdentity,
  RestArkProvider,
  RestDelegateProvider,
  SettlementEventType,
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
const DELEGATE_URL = "https://delegate.arkade.money" as const;
const EXPLORER_URL = "https://arkade.space" as const;

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

/** 5. Fetch available balance */
const { available, assets } = await wallet.getBalance();

/** 6. Create 2 subdust outputs */
const required =
  wallet.dustAmount * 2n + (assets.length ? wallet.dustAmount : 0n);
const subdustAmount = Number(wallet.dustAmount) / 2;

if (available <= required) {
  throw new Error(`Wallet balance must exceed ${required}`, {
    cause: await wallet.getAddress(),
  });
}

const subdustTxid1 = await wallet.send({
  address: await wallet.getAddress(),
  amount: subdustAmount,
});

console.log(
  `Created subdust output of ${subdustAmount}: ${EXPLORER_URL}/tx/${subdustTxid1}`,
);

// Wait 500ms
await new Promise((resolve) => setTimeout(resolve, 500));

const subdustTxid2 = await wallet.send({
  address: await wallet.getAddress(),
  amount: subdustAmount,
});

console.log(
  `Created subdust output of ${subdustAmount}: ${EXPLORER_URL}/tx/${subdustTxid2}`,
);

// Wait another 500ms
await new Promise((resolve) => setTimeout(resolve, 500));

/** 6. Settle into single output */
const manager = await wallet.getVtxoManager();

const settlementTxid = await manager.recoverVtxos((event) => {
  console.log(event.type);
  if (event.type !== SettlementEventType.BatchFinalized) return;
});

console.log(
  `Settlement complete: ${EXPLORER_URL}/commitment-tx/${settlementTxid}`,
);

/** 7. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
