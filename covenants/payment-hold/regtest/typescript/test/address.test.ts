import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    arkade,
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
    networks,
    VtxoScript,
    type EmulatorProvider,
} from "@arkade-os/sdk";
import { paymentHoldProgram, type AsmTokens } from "../src/lib/program.ts";

// Deterministic, valid curve points: fixed secrets → fixed x-only keys.
const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));

const serverKey = key(0x01);
const emulatorKey = key(0x02);
const merchantPubkey = key(0x03);
const customerPubkey = key(0x04);

const args = {
    merchantPubkey,
    customerPubkey,
    merchantPayout: new Uint8Array(32).fill(0x0a),
    customerPayout: new Uint8Array(32).fill(0x0b),
    orderSalt: new Uint8Array(8).fill(0x0c),
    releaseHeight: 1_000n,
    exitBlocks: 144n,
};

// Recorded from the hand-built tree below; a change here means the program's
// compiled taproot tree (and every derived contract address) changed.
const GOLDEN_ADDRESS =
    "tark1qqdcf32k0vfxgsyet5ldt246q4jaw8scx3sysx0lnstlt6w4m5rcljjgvgmu6dg7vef8lrrr8tqslnlpwgp0sda73fydupk3yjcn8njcxetghf";

async function connect() {
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
    const emulator: EmulatorProvider = {
        async getInfo() {
            return { signerPubkey: hex.encode(emulatorKey) };
        },
        async submitTx(arkTx: string, checkpointTxs: string[]) {
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
    return arkade.Arkade.connect({
        arkade: arkProvider,
        emulator,
        network: networks.regtest,
    });
}

describe("payment-hold address derivation", () => {
    it("matches an independently hand-built taproot tree", async () => {
        const ark = await connect();
        const contract = ark.contract(paymentHoldProgram, args);

        const covenant = (name: "capture" | "captureAll" | "void" | "reclaim") =>
            arkade.resolveAsm(paymentHoldProgram.functions[name].arkadeScript.asm as AsmTokens, {
                ...args,
                server: serverKey,
            });
        const tweak = (script: Uint8Array) =>
            arkade.computeArkadeScriptPublicKey(emulatorKey, script);

        // Leaves in program declaration order, mirroring the SDK's compile path:
        // resolved signers first, tweaked co-signer appended on covenant paths.
        const leaves = [
            MultisigTapscript.encode({
                pubkeys: [merchantPubkey, serverKey, tweak(covenant("capture"))],
            }).script,
            MultisigTapscript.encode({
                pubkeys: [merchantPubkey, serverKey, tweak(covenant("captureAll"))],
            }).script,
            MultisigTapscript.encode({
                pubkeys: [merchantPubkey, serverKey, tweak(covenant("void"))],
            }).script,
            CLTVMultisigTapscript.encode({
                absoluteTimelock: 1_000n,
                pubkeys: [customerPubkey, serverKey, tweak(covenant("reclaim"))],
            }).script,
            CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: 144n },
                pubkeys: [merchantPubkey],
            }).script,
        ];
        const raw = new VtxoScript(leaves);

        expect(contract.address).toBe(raw.address(networks.regtest.hrp, serverKey).encode());
        expect(hex.encode(contract.pkScript)).toBe(hex.encode(raw.pkScript));
    });

    it("is stable across SDK/program changes (golden)", async () => {
        const ark = await connect();
        const contract = ark.contract(paymentHoldProgram, args);
        expect(contract.address).toBe(GOLDEN_ADDRESS);
    });

    it("changes when the order salt changes (one address per hold)", async () => {
        const ark = await connect();
        const a = ark.contract(paymentHoldProgram, args);
        const b = ark.contract(paymentHoldProgram, {
            ...args,
            orderSalt: new Uint8Array(8).fill(0x0d),
        });
        expect(a.address).not.toBe(b.address);
    });
});
