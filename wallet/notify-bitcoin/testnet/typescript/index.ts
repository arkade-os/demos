import {
  type Coin,
  ESPLORA_URL,
  EsploraProvider,
  type ExtendedCoin,
  type ExtendedVirtualCoin,
  MnemonicIdentity,
  RestArkProvider,
  RestDelegateProvider,
  Wallet,
  isVirtualCoin,
} from "@arkade-os/sdk";
import {
  type SQLExecutor,
  SQLiteContractRepository,
  SQLiteWalletRepository,
} from "@arkade-os/sdk/repositories/sqlite";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;

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
  /** Explicitly configure onchain provider with polling */
  onchainProvider: new EsploraProvider(ESPLORA_URL["mutinynet"], {
    forcePolling: true,
  }),
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

/** 4. Get initial output sets */
const outputs = (
  await Promise.all([
    wallet.getBoardingUtxos(),
    wallet.getVtxos({
      /** Include recoverable (non-spendable) outputs */
      withRecoverable: true,
    }),
  ])
).flat();

/** 5. Log basic details of outputs */
const formatOutputs = (
  outputs: Coin[] | ExtendedCoin[] | ExtendedVirtualCoin[],
) =>
  outputs.map((output) => {
    const { txid, vout, value } = output;
    if (isVirtualCoin(output)) {
      const { isPreconfirmed, isSwept, isSpent } = output;
      return {
        type: "virtual-output",
        txid,
        vout,
        value,
        isPreconfirmed,
        isSwept,
        isSpent,
      } as const;
    } else {
      const {
        status: { confirmed },
      } = output;
      return {
        type: "boarding-input",
        txid,
        vout,
        value,
        status: confirmed ? "confirmed" : "pending",
      } as const;
    }
  });

console.log("Initial output set:", formatOutputs(outputs));

/** 6. Subscribe for incoming funds */
const stopNotifying = await wallet.notifyIncomingFunds(async (event) => {
  if (event.type === "utxo") {
    const { coins } = event;
    console.log("New boarding inputs:", formatOutputs(coins));
  } else {
    const { spentVtxos, newVtxos } = event;
    /** Filter both spent + new outputs into bundles */
    if (spentVtxos.length) {
      console.log("Spent virtual outputs:", formatOutputs(spentVtxos));
    }
    if (newVtxos.length) {
      console.log("New virtual outputs:", formatOutputs(newVtxos));
    }
  }
});

console.log("Listening for incoming deposits...");
console.log("Arkade deposit address:", await wallet.getAddress());
console.log("Boarding address:", await wallet.getBoardingAddress());
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
