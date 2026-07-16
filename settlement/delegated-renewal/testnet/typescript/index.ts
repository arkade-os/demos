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

/** When to process the delegation request */
const DELEGATE_IN_SECONDS = 60 as const;

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;
const ONE_DAY_IN_SECONDS = 259_200 as const;

/** 1. Polyfill EventSource
 * EventSource is used internally by the SDK for settlement events (SSE).
 * It is not available in Node.js by default, so we need to polyfill it.
 */
console.log("Polyfilling EventSource...");
(globalThis as any).EventSource = EventSource;

/** 2. Initialize SQLite database */
console.log("Initalizing SQLite database...");
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

/** 3. Create wallet */
console.log("Creating wallet...");
const wallet = await Wallet.create({
  identity: MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
    isMainnet: false,
  }),
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

/** 4. Fetch delegable outputs */
console.log("Fetching delegable outputs...");
const contractManager = await wallet.getContractManager();
let delegableOutputs = await contractManager
  .getContractsWithVtxos({
    /** Filter only for scripts with delegate path */
    type: "delegate",
  })
  .then((contractsWithOutputs) =>
    contractsWithOutputs
      .flatMap(({ vtxos }) => vtxos)
      /** Filter out spent or unrolled outputs */
      .filter((output) => !(output.isSpent || output.isUnrolled)),
  );

if (!delegableOutputs.length) {
  throw new Error("No delegable outputs:", {
    cause: await wallet.getAddress(),
  });
}

const delegableTotal = delegableOutputs.reduce((total, output) => {
  return BigInt(output.value) + total;
}, 0n);

if (delegableTotal < wallet.dustAmount) {
  throw new Error("Delegable total is under dust amount:", {
    cause: {
      address: await wallet.getAddress(),
      total: delegableTotal,
      need: wallet.dustAmount - delegableTotal,
    },
  });
}

/** 5. Sweep previously settled outputs (if necessary)
 *
 * Delegation requests will be rejected if any of the inputs are invalid,
 * which includes recently settled virtual outputs.
 *
 * Spending them replaces them with a single preconfirmed output.
 *
 */
const settledOutputs = delegableOutputs.filter(
  (output) => output.settledBy?.length,
);

const earliestCreatedAt = settledOutputs.reduce((earliest, output) => {
  return output.createdAt.getTime() / 1000 < earliest
    ? output.createdAt.getTime() / 1000
    : earliest;
}, Infinity);

if (
  settledOutputs.length === delegableOutputs.length &&
  Math.floor(Date.now() / 1000) - earliestCreatedAt < ONE_DAY_IN_SECONDS
) {
  throw new Error(
    "All outputs in this wallet are already settled and less than 24 hours old",
    {
      cause: await wallet.getAddress(),
    },
  );
}

if (settledOutputs.length > 0) {
  console.log("Sweeping previously settled outputs to self...");
  const sweepTxid = await wallet.sendSelectedVtxosToSelf(settledOutputs);
  console.log(`Swept: ${EXPLORER_URL}/tx/${sweepTxid}`);
  /** Wait 500ms for indexer to update */
  await new Promise((resolve) => setTimeout(resolve, 500));
  /** Refresh delegable outputs */
  delegableOutputs = await contractManager
    .getContractsWithVtxos({
      type: "delegate",
    })
    .then((contractsWithOutputs) =>
      contractsWithOutputs
        .flatMap(({ vtxos }) => vtxos)
        /** Filter out spent, unrolled, or settled outputs */
        .filter(
          (output) =>
            !(output.isSpent || output.isUnrolled || output.settledBy?.length),
        ),
    );
}

/** 6. Submit delegation request */
const delegateManager = await wallet.getDelegateManager();

if (!delegateManager) {
  throw new Error("Could not initalize delegate manager");
}

console.log(
  `Requesting delegation of ${delegableOutputs.length} output(s):`,
  delegableOutputs.map(({ txid, vout }) => `${txid}:${vout}`),
);
const { failed, delegated } = await delegateManager.delegate(
  /** Outputs to renew */
  delegableOutputs,
  /** Where to send them */
  await wallet.getAddress(),
  /** When to process the request */
  new Date(Date.now() + DELEGATE_IN_SECONDS * 1000),
);

if (delegated.length) {
  console.log(
    `Delegated renewal of ${delegated.length} output(s):`,
    delegated.map(({ txid, vout }) => `${txid}:${vout}`),
  );
}

if (delegated.length < delegableOutputs.length) {
  throw new Error(
    `Delegation failed for ${delegableOutputs.length - delegated.length} output(s):`,
    {
      cause: failed,
    },
  );
}

/** 8. Graceful shutdown */
console.log("Disposing contract manager...");
contractManager.dispose();

console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
