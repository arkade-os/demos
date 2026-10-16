/**
 * `pnpm faucet <ark-address> [amount]` — fund a demo wallet on regtest.
 * Copy the address from the merchant/customer page header.
 */
import { faucetOffchain, preflight } from "./regtest.ts";

const [address, amountArg] = process.argv.slice(2);
if (!address?.startsWith("tark")) {
    console.error("usage: pnpm faucet <tark1…address> [amount=100000]");
    process.exit(1);
}
const amount = Number(amountArg ?? 100_000);

await preflight();
faucetOffchain(address, amount);
console.log(`sent ${amount} sats to ${address}`);
