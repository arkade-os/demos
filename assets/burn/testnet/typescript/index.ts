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
const IGNORE_ASSETS = [
  "3dcc62d9d8437f8f80249eaf2c62b1af612aff49c1bd6a904628c95c7b4f9eaa0000",
  "952ce3af7dd640a80984962156b63e7b3d3f2726c22f46e14f81daac2297170b0000",
];

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
    walletRepository: new SQLiteWalletRepository(sqlExecutor),
    contractRepository: new SQLiteContractRepository(sqlExecutor),
  },
});

/** 5. Fetch asset balances */
const assets = await wallet.getBalance().then((balance) => balance.assets);

/** 6. Filter assets to burn */
const toBurn = assets.filter(({ assetId }) => !IGNORE_ASSETS.includes(assetId));

if (!toBurn.length) {
  throw new Error("Could not find any assets to burn", {
    cause: await wallet.getAddress(),
  });
}

/** 7. Get asset manager */
const manager = wallet.assetManager;

/** 8. Burn assets */
const burnResults: Array<{
  assetId: string;
  amount: bigint;
  burnTxid: string;
}> = [];

for (const asset of toBurn) {
  const burnTxid = await manager.burn(asset);

  console.log(
    `Burned ${asset.amount} units of ${asset.assetId}: ${EXPLORER_URL}/tx/${burnTxid}`,
  );

  burnResults.push({
    ...asset,
    burnTxid,
  });

  // Wait 500ms between burns
  if (asset !== toBurn[toBurn.length - 1]) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** 9. Print summary */
console.log(burnResults.flat());

/** 10. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
