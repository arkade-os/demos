/**
 * Wallet helper shared by the writer CLI and the solver daemon: a SingleKey
 * identity persisted under .state/<name>.json, wrapped in an in-memory-repo
 * Wallet (balance and VTXOs re-sync from the indexer on every run).
 */

import { randomBytes } from "node:crypto";
import { hex } from "@scure/base";
import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  SingleKey,
  Wallet,
} from "@arkade-os/sdk";
import { loadState, OPERATOR_URL, saveState, sleep } from "./contract.ts";

export async function openWallet(name: "writer" | "solver") {
  const stateKey = `${name}-key`;
  const stored = loadState<string | null>(stateKey, null);
  const keyHex = stored ?? hex.encode(randomBytes(32));
  if (!stored) saveState(stateKey, keyHex);

  const identity = SingleKey.fromHex(keyHex);
  const wallet = await Wallet.create({
    identity,
    arkProvider: new RestArkProvider(OPERATOR_URL),
    settlementConfig: false,
    walletMode: "static",
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  });
  return { identity, wallet };
}

/** Poll until the available balance grows by `minDelta`, or time out. */
export async function waitForFunds(
  wallet: Awaited<ReturnType<typeof openWallet>>["wallet"],
  baseline: bigint,
  minDelta: bigint,
  timeoutSeconds: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const { available } = await wallet.getBalance();
    if (BigInt(available) >= baseline + minDelta) return BigInt(available);
    await sleep(3000);
  }
  throw new Error(`timed out waiting for funds (baseline ${baseline}, want +${minDelta})`);
}
