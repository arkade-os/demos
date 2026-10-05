import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { arkade, CSVMultisigTapscript, networks, type EmulatorProvider } from "@arkade-os/sdk";
import type { HoldTerms } from "../src/lib/terms.ts";

/** Deterministic, valid curve point: fixed secret → fixed x-only key. */
export const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));

export const serverKey = key(0x01);
export const emulatorKey = key(0x02);
export const merchantPubkey = key(0x03);
export const customerPubkey = key(0x04);

export function sampleTerms(): HoldTerms {
    return {
        merchantPubkey,
        customerPubkey,
        // Payout witness programs must be valid taproot output keys —
        // btc-signer validates them when the spend outputs are built.
        merchantPayout: key(0x0a),
        customerPayout: key(0x0b),
        orderSalt: new Uint8Array(8).fill(0x0c),
        releaseHeight: 1_000,
        exitBlocks: 144,
        holdAmount: 50_000n,
        label: "test",
    };
}

/** Offline Arkade client over stub providers (pattern from the SDK's own tests). */
export async function stubConnect(opts?: { identityKey?: Uint8Array }): Promise<{
    ark: arkade.Arkade;
    captured: { arkTx?: string };
}> {
    const arkProvider = {
        async getInfo() {
            return {
                signerPubkey: "02" + hex.encode(serverKey),
                checkpointTapscript: hex.encode(
                    CSVMultisigTapscript.encode({
                        timelock: { type: "blocks", value: 10n },
                        pubkeys: [serverKey],
                    }).script,
                ),
            } as any;
        },
        async submitTx(): Promise<never> {
            throw new Error("not used");
        },
        async finalizeTx() {},
    };
    const captured: { arkTx?: string } = {};
    const emulator: EmulatorProvider = {
        async getInfo() {
            return { signerPubkey: hex.encode(emulatorKey) };
        },
        async submitTx(arkTx: string, checkpointTxs: string[]) {
            captured.arkTx = arkTx;
            return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs };
        },
        async submitIntent(): Promise<never> {
            throw new Error("not used");
        },
        async submitFinalization(): Promise<never> {
            throw new Error("not used");
        },
        async submitOnchainTx(): Promise<never> {
            throw new Error("not used");
        },
    };
    const identity = opts?.identityKey
        ? ({
              xOnlyPublicKey: async () => opts.identityKey!,
              sign: async (tx: unknown) => tx,
          } as any)
        : undefined;
    const ark = await arkade.Arkade.connect({
        arkade: arkProvider,
        emulator,
        identity,
        network: networks.regtest,
    });
    return { ark, captured };
}

export const COIN: arkade.Utxo = {
    txid: hex.encode(new Uint8Array(32).fill(0x21)),
    vout: 0,
    value: 50_000,
};
