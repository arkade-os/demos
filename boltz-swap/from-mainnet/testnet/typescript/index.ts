import { ArkadeSwaps, type BoltzSwap } from "@arkade-os/boltz-swap";
import { SQLiteSwapRepository } from "@arkade-os/boltz-swap/repositories/sqlite";
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

const ARKADE_AMOUNT = 10_000 as const;

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;
const QRSERVER_URL = "https://api.qrserver.com" as const;

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

/** 5. Create ArkadeSwaps instance */
const swaps = await ArkadeSwaps.create({
  /**
   * Provider is automatically inferred from wallet network,
   * Swap manager (for auto-claiming, refunds) is enabled by default */
  wallet,
  /**
   * Explicitly use SQLite storage
   * Defaults to IndexedDB if undefined
   */
  swapRepository: new SQLiteSwapRepository(sqlExecutor),
});

if (!swaps.swapManager) {
  throw new Error("Swap manager not auto-configured");
}

/** 6. Create mainnet > Arkade swap */
const result = await swaps.btcToArk({
  /**
   * Amount to be received on Arkade
   * This will automatically adjust the amount to be sent on mainnet
   * If you want to instead specify a particular amount to send on mainnet, use senderLockAmount
   */
  receiverLockAmount: ARKADE_AMOUNT,
});

console.log("Created mainnet > Arkade swap:");
console.log({
  /** The amount to be paid over mainnet */
  amountToPay: result.amountToPay,
  /** The amount that will be delivered on Arkade */
  deliveredAmount: result.pendingSwap.amount,
  /** Where the funds will be locked on mainnet */
  lockupAddress: result.btcAddress,
  /** Where the funds will be claimed from on Arkade */
  claimAddress: result.pendingSwap.response.claimDetails.lockupAddress,
  /** The secret preimage that, when revealed, allows the funds to be claimed on Arkade */
  preimage: result.pendingSwap.preimage,
  /** The ripemd160(sha256()) hash of the preimage */
  paymentHash: result.pendingSwap.request.preimageHash,
});
console.log(
  `Pay here: ${QRSERVER_URL}/v1/create-qr-code/?qzone=1&data=${result.pendingSwap.response.lockupDetails.bip21}`,
);

console.log("Monitoring for payment...");
console.log("(press Enter to close)");

/** 7. Set up event listener for the updated swap */
const stopNotifyingSwaps = await swaps.swapManager?.onSwapUpdate(
  (swap: BoltzSwap) => {
    if (swap.type !== "chain" && swap.id === result.pendingSwap.id) {
      console.warn("Unexpected swap update:", swap);
    }
    console.log("Updated mainnet > Arkade swap:", {
      status: swap.status,
    });
  },
);

/** 8. Subscribe for incoming funds for the claimed swap */
const stopNotifyingWallet = await wallet.notifyIncomingFunds(async (event) => {
  /** Ignore boarding inputs */
  if (event.type === "utxo") return;
  const { newVtxos } = event;
  /** Ignore spent outputs */
  if (!newVtxos.length) return;
  /** Attempt to identify the claim transaction */
  const claimOutput = newVtxos.find(
    (output) =>
      output.value === result.pendingSwap.response.claimDetails.amount,
  );
  if (!claimOutput) {
    console.warn("Unexpected new output(s):", newVtxos);
    return;
  }
  console.log(
    `Likely claim transaction: ${EXPLORER_URL}/tx/${claimOutput.txid}`,
  );
});

/** 9. Graceful shutdown */
if (process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.once("data", async () => {
    try {
      console.log("Stopping swap notifications...");
      stopNotifyingSwaps();

      // Not recommended for production!
      console.log("Clearing swaps from DB...");
      await swaps.swapRepository.clear();

      console.log("Disposing swaps...");
      await swaps.dispose();

      console.log("Stopping wallet notifications...");

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
