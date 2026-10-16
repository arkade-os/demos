import {
  type ExitOptions,
  MnemonicIdentity,
  OnchainWallet,
  RestArkProvider,
  RestDelegateProvider,
  serializeExitPackage,
  UnilateralExit,
  Wallet,
} from "@arkade-os/sdk";
import {
  type SQLExecutor,
  SQLiteContractRepository,
  SQLiteWalletRepository,
} from "@arkade-os/sdk/repositories/sqlite";
import { writeFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * A separate wallet from the other demos:
 * an exit takes its outputs out of Arkade for good
 */
const SEED_PHRASE =
  "legal winner thank year wave sausage worth useful legal winner thank yellow" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;
const MEMPOOL_URL = "https://mutinynet.com" as const;
const PACKAGE_PATH = "exit-package.json" as const;

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

/**
 * 4. Create onchain wallet (same identity)
 * Pays the exit's miner fees, and receives the exited funds
 */
const onchainWallet = await OnchainWallet.create(identity, "mutinynet");

/** 5. Fetch spendable outputs */
const outputs = await wallet.getVtxos({ withRecoverable: false });

if (!outputs.length) {
  throw new Error("No outputs to exit", {
    cause: await wallet.getAddress(),
  });
}

/**
 * 6. Settle preconfirmed outputs (if any)
 *
 * A preconfirmed output's exit path runs through every offchain transaction
 * since its last batch, and those transactions also carry other people's
 * outputs (the sender's change, for one). Settling first gives the funds a
 * batch leaf of their own, so the exit publishes fewer transactions and
 * pushes nobody else's outputs onchain.
 */
if (outputs.some((output) => output.isPreconfirmed)) {
  console.log("Settling preconfirmed outputs...");
  const settlementTxid = await wallet.settle();
  console.log(`Settled: ${EXPLORER_URL}/commitment-tx/${settlementTxid}`);
}

/** 7. Describe the exit */
const exitOptions = {
  wallet,
  onchainWallet,
  /** Where the exited funds go */
  sweepAddress: onchainWallet.address,
  /**
   * Required on mutinynet and signet
   * The SDK can't tell them apart from testnet by address prefix
   */
  networkName: "mutinynet",
  /**
   * "funded" (default): pre-fund and pre-sign every fee transaction now,
   * so processing the package needs no keys at all
   */
  mode: "funded",
} as const satisfies ExitOptions;

/** 8. Estimate cost (signs nothing, spends nothing) */
const quote = await UnilateralExit.estimate(exitOptions);

console.log("Exit quote:", {
  feeRate: `${quote.feeRate} sat/vB`,
  ...quote.totals,
  outputs: quote.vtxos.map(({ outpoint, value, path, delay, skipped }) => ({
    outpoint,
    value,
    /** Which spending path the exit uses */
    path,
    /** How long the funds stay locked once the output is onchain */
    delay: delay && `${delay.value} ${delay.type}`,
    skipped,
  })),
});

if (quote.shortfallSats > 0) {
  throw new Error(
    `Onchain wallet needs ${quote.shortfallSats} more confirmed sats to pay exit fees`,
    { cause: onchainWallet.address },
  );
}

/**
 * 9. Prepare exit package
 *
 * Signs every transaction the exit needs, and broadcasts the "splitter",
 * which reserves the onchain fee budget so that later wallet activity
 * can't spend it out from under the package
 */
const exitPackage = await UnilateralExit.prepare(exitOptions);

const splitter = exitPackage.steps.find((step) => step.kind === "broadcast");
if (splitter) {
  console.log(`Broadcast fee splitter: ${MEMPOOL_URL}/tx/${splitter.txid}`);
}

/** 10. Save exit package */
writeFileSync(PACKAGE_PATH, serializeExitPackage(exitPackage));

console.log(`Saved exit package to ${PACKAGE_PATH}:`, {
  steps: exitPackage.steps.map(({ kind }) => kind),
  ...exitPackage.totals,
  /**
   * The operator can sweep the batch after this time,
   * so the package must be processed (or prepared again) before then
   */
  validUntil: exitPackage.validUntil
    ? new Date(exitPackage.validUntil * 1000).toISOString()
    : undefined,
});

/** 11. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
