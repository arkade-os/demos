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
import { arkadeLnurl } from "@arkade-os/lnurl-client/arkade";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Becomes USERNAME@lnurl.mutinynet.arkade.sh
 * Owned by the wallet below: with your own seed phrase, pick a free name
 */
const USERNAME = "arkade-demos" as const;

/**
 * The receiver's wallet
 * The seed phrase is public, so anyone can re-point this address: use your own
 */
const SEED_PHRASE =
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
/** Hosted lnurl-server (github.com/ArkLabsHQ/lnurl-server), with offline receive */
const LNURL_URL = "https://lnurl.mutinynet.arkade.sh" as const;

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
   * (the lnurl-server pays the address registered below)
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
 * 4. Connect to lnurl-server
 * The wallet signs a per-domain session token, which owns its addresses there
 */
const lnurl = arkadeLnurl({ wallet, baseUrl: LNURL_URL });

/**
 * 5. Claim Lightning address
 *
 * Registers the name (re-claiming one you own is fine), then binds the
 * wallet's Arkade address and claim public key to it. That binding is what
 * enables offline receive: when no wallet session is connected, the server
 * quotes a Lightning -> Arkade swap with a solver, hands the payer the
 * solver's hold invoice, and claims the funds to the bound address itself.
 * A covenant only lets that claim pay the bound address.
 */
const receiver = await lnurl.claim({ username: USERNAME });

console.log(`Lightning address: ${receiver.lightningAddress}`);
console.log(`LNURL: ${receiver.lnurl}`);

/** 6. Show how payers can pay it */
const { paymentOptions, minSendable, maxSendable } =
  await receiver.payRequest();

console.log("Payment options:", {
  options: paymentOptions?.map(({ id }) => id),
  minSats: minSendable / 1000,
  maxSats: maxSendable / 1000,
});

/** 7. Show payments received so far (recorded by the server) */
const { payments } = await receiver.payments();

console.log(
  "Settled payments:",
  payments
    .filter((payment) => payment.settled)
    .map((payment) => ({
      rail: payment.kind === "bolt11" ? "lightning" : payment.paymentOption,
      sats: (payment.amountMsat ?? 0) / 1000,
      settledAt: new Date(payment.settledAt ?? payment.createdAt).toISOString(),
    })),
);

/** 8. Fetch balance */
const { available } = await wallet.getBalance();
console.log(`Available balance: ${available} sats`);

/** 9. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();

console.log(
  `Wallet is offline: payments to ${receiver.lightningAddress} still arrive (see the pay-address demo)`,
);
