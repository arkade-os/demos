import {
  deserializeExitPackage,
  EsploraProvider,
  UnilateralExit,
} from "@arkade-os/sdk";
import { existsSync, readFileSync } from "node:fs";

/**
 * Written by the prepare-package demo
 * The package holds only pre-signed transactions, no keys
 */
const PACKAGE_PATH =
  "../../../prepare-package/testnet/typescript/exit-package.json" as const;
const ESPLORA_URL = "https://mempool.mutinynet.arkade.sh/api" as const;
const MEMPOOL_URL = "https://mutinynet.com" as const;

/** 1. Load exit package */
if (!existsSync(PACKAGE_PATH)) {
  throw new Error("No exit package found, run the prepare-package demo first", {
    cause: PACKAGE_PATH,
  });
}

const exitPackage = deserializeExitPackage(readFileSync(PACKAGE_PATH, "utf8"));

console.log("Loaded exit package:", {
  network: exitPackage.network,
  mode: exitPackage.mode,
  sweepAddress: exitPackage.sweepAddress,
  ...exitPackage.totals,
});

/**
 * 2. Connect to a Bitcoin explorer
 * The only thing processing needs: no wallet, no keys, no Arkade operator
 */
const explorer = new EsploraProvider(ESPLORA_URL);

/**
 * 3. Process exit package
 *
 * Broadcasts each virtual transaction with its fee child, waits for each to
 * confirm, then waits out the exit timelock and broadcasts the sweeps.
 * The blockchain is the only state, so this can be stopped and re-run
 * (anywhere) and it picks up where the chain says it is.
 */
const executor = new UnilateralExit.Executor(exitPackage, explorer, {
  pollIntervalMs: 10_000,
});

for await (const event of executor) {
  const step = `[${event.stepIndex + 1}/${exitPackage.steps.length}] ${event.kind}`;
  const link = event.txid ? `${MEMPOOL_URL}/tx/${event.txid}` : "";

  switch (event.status) {
    case "waiting_csv":
      console.log(
        `${step} waiting for exit timelock until`,
        event.maturesAtTime
          ? new Date(event.maturesAtTime * 1000).toISOString()
          : `block ${event.maturesAtHeight}`,
      );
      break;
    case "failed":
    case "warning":
      console.warn(`${step} ${event.status}: ${event.reason}`, link);
      break;
    default:
      console.log(`${step} ${event.status}`, link);
  }
}

/** 4. Check exited funds */
const coins = await explorer.getCoins(exitPackage.sweepAddress);
const total = coins.reduce((sum, coin) => sum + coin.value, 0);

console.log(
  `Exit complete: ${exitPackage.sweepAddress} holds ${total} sats onchain`,
);
