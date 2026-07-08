import {
  MnemonicIdentity,
  RestArkProvider,
  RestDelegateProvider,
  Wallet,
  type ContractVtxo,
  type Outpoint,
} from "@arkade-os/sdk";
import {
  SQLiteContractRepository,
  SQLiteWalletRepository,
  type SQLExecutor,
} from "@arkade-os/sdk/repositories/sqlite";
import { hex } from "@scure/base";
import Database from "better-sqlite3";
import { EventSource } from "eventsource";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;

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

/** 5. Fetch delegable outputs */
const contractManager = await wallet.getContractManager();
const contractsWithOutputs = await contractManager.getContractsWithVtxos({
  /** Filter only for current delegated script */
  script: hex.encode(wallet.arkAddress.pkScript),
  /** Filter only for scripts with delegate path */
  type: "delegate",
});
/** Filter out spent or unrolled outputs */
const delegableOutputs = contractsWithOutputs
  .flatMap(({ vtxos }) => vtxos)
  .filter((output) => !(output.isSpent || output.isUnrolled));

const delegatedAddresses = contractsWithOutputs.flatMap(
  ({ contract: { address } }) => address,
);

if (delegableOutputs.length === 0) {
  throw new Error("No delegable outputs", {
    cause: delegatedAddresses,
  });
}

/** 6. Construct delegation request */
const delegateManager = await wallet.getDelegateManager();

if (!delegateManager) {
  throw new Error("Could not initalize delegate manager");
}

const delegationResult = await delegateManager.delegate(
  delegableOutputs,
  /** This should equal the current delegated address */
  wallet.arkAddress.encode(),
  /** Process delegation immediately */
  new Date(),
);

if (delegationResult.failed.length !== 0) {
  throw new Error("Delegation failed", {
    cause: delegationResult,
  });
}

// Temporary cast for type mismatch
const delegatedOutpoints = (
  delegationResult.delegated as unknown as ContractVtxo[]
).map(({ txid, vout }) => ({
  txid,
  vout,
})) as Outpoint[];

console.log(
  `Delegated renewal of ${delegatedOutpoints.length} outputs:`,
  delegatedOutpoints,
);

/** 7. Graceful shutdown */
console.log("Disposing contract manager...");
contractManager.dispose();

console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
