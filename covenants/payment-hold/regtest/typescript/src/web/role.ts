/** Shared bootstrap for the two role pages: identity, wallet, arkade client. */
import { hex } from "@scure/base";
import { SingleKey, Wallet, arkade, RestIndexerProvider } from "@arkade-os/sdk";
import { connectArkade, createRoleWallet, indexerProvider } from "../lib/client.ts";
import { loadOrCreateKeyHex } from "./ui.ts";

export interface RoleContext {
    role: "merchant" | "customer";
    identity: SingleKey;
    wallet: Wallet;
    ark: arkade.Arkade;
    indexer: RestIndexerProvider;
    address: string;
    pubkey: Uint8Array;
    pubkeyHex: string;
}

export const storageKeys = (role: string) => ({
    key: `payment-hold-demo:${role}:key`,
    holds: `payment-hold-demo:${role}:holds`,
});

export async function initRole(role: "merchant" | "customer"): Promise<RoleContext> {
    const identity = SingleKey.fromHex(loadOrCreateKeyHex(storageKeys(role).key));
    const wallet = await createRoleWallet(identity);
    const ark = await connectArkade(identity);
    const indexer = indexerProvider();
    const address = await wallet.getAddress();
    const pubkey = await identity.xOnlyPublicKey();
    return { role, identity, wallet, ark, indexer, address, pubkey, pubkeyHex: hex.encode(pubkey) };
}

export function resetRole(role: string): void {
    const keys = storageKeys(role);
    localStorage.removeItem(keys.key);
    localStorage.removeItem(keys.holds);
    location.reload();
}
