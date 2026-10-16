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
import { createLnurlClient } from "@arkade-os/lnurl-client";
import { btcOn, createSwapClient } from "@arkade-os/swap";
import { SQLiteAssetSwapRepository } from "@arkade-os/swap/repositories/sqlite";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Registered by the register-address demo, whose wallet stays offline */
const LIGHTNING_ADDRESS = "arkade-demos@lnurl.mutinynet.arkade.sh" as const;
/** Sats the Lightning invoice asks for */
const AMOUNT = 2_000 as const;
/** Most this wallet pays the solver on top of AMOUNT */
const MAX_FEE = 100n as const;

/** The payer's wallet */
const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

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

/** 4. Check available balance */
const { available } = await wallet.getBalance();
const required = AMOUNT + Number(MAX_FEE);

if (available < required) {
  throw new Error(`Wallet balance must be at least ${required}`, {
    cause: await wallet.getAddress(),
  });
}

/** 5. Resolve Lightning address (LUD-16) */
const payer = createLnurlClient();
const payRequest = await payer.resolve(LIGHTNING_ADDRESS);

/**
 * 6. Request invoice
 *
 * The receiver's wallet isn't connected, so lnurl-server quotes a
 * Lightning -> Arkade swap with a solver and returns the solver's hold
 * invoice. The server holds the preimage, and uses it to claim the solver's
 * lockup to the receiver's registered Arkade address.
 */
const invoice = await payer.requestInvoice(payRequest, {
  amountSat: AMOUNT,
  paymentOption: "lightning",
});

if (invoice.kind !== "bolt11" || !invoice.verify) {
  throw new Error("Expected a verifiable Lightning invoice", {
    cause: invoice,
  });
}

console.log(`Invoice for ${AMOUNT} sats: ${invoice.pr}`);

/**
 * 7. Create swap client (this wallet's Lightning wallet)
 * Swap records go in the same SQLite database, so a re-run resumes them
 */
const swapClient = createSwapClient({
  wallet,
  repository: new SQLiteAssetSwapRepository(sqlExecutor),
});
await swapClient.ready;

/**
 * 8. Pay invoice (Arkade -> Lightning)
 * Locks AMOUNT plus the fee in a swap contract that the solver can only
 * claim by revealing the invoice's preimage
 */
const payment = await swapClient.pay(invoice.pr, {
  maxFee: { amount: MAX_FEE, asset: btcOn("arkade", "mutinynet") },
});

if (payment.kind !== "swap") {
  throw new Error("Expected a swap", { cause: payment });
}

const { swap } = payment;
console.log(
  `Locked ${swap.give.amount} sats (fee ${swap.fee?.amount ?? 0n}): ${EXPLORER_URL}/tx/${swap.fundingTxid}`,
);

swapClient.onUpdate((update) => {
  if (update.swap.id === swap.id) console.log(`Swap ${update.outcome}`);
});

/**
 * 9. Wait for the receiver's confirmation (LUD-21)
 * Settles once lnurl-server has claimed the funds for the offline wallet,
 * and the returned preimage is the proof of payment
 */
const status = await payer.pollVerify(invoice.verify, {
  timeoutMs: 600_000,
  intervalMs: 5_000,
  expect: invoice,
});

if (status.kind === "bolt11" && status.settled) {
  console.log(`Paid ${LIGHTNING_ADDRESS}, preimage: ${status.preimage}`);
}

/** 10. Graceful shutdown */
console.log("Disposing swap client...");
await swapClient[Symbol.asyncDispose]();

console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
