import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { arkade, Extension } from "@arkade-os/sdk";
import { paymentHoldProgram, type AsmTokens } from "../src/lib/program.ts";
import { programArgs, wpToPkScript } from "../src/lib/hold.ts";
import { COIN, merchantPubkey, sampleTerms, serverKey, stubConnect } from "./helpers.ts";

const terms = sampleTerms();

function contractOf(ark: arkade.Arkade) {
    return ark.contract(paymentHoldProgram, programArgs(terms));
}

describe("spend transaction shape (offline)", () => {
    it("capture builds [merchant, change, extension, anchor] with the amount witness", async () => {
        const { ark } = await stubConnect({ identityKey: merchantPubkey });
        const contract = contractOf(ark);

        const { arkTx } = await contract.functions
            .capture(30_000n)
            .from(COIN)
            .to(wpToPkScript(terms.merchantPayout), 30_000n)
            .to(wpToPkScript(terms.customerPayout), 20_000n)
            .build();

        expect(arkTx.outputsLength).toBe(4);
        const out0 = arkTx.getOutput(0);
        const out1 = arkTx.getOutput(1);
        expect(out0.amount).toBe(30_000n);
        expect(hex.encode(out0.script!)).toBe(hex.encode(wpToPkScript(terms.merchantPayout)));
        expect(out1.amount).toBe(20_000n);
        expect(hex.encode(out1.script!)).toBe(hex.encode(wpToPkScript(terms.customerPayout)));

        // Extension OP_RETURN before the P2A anchor.
        const ext = arkTx.getOutput(2);
        expect(ext.amount).toBe(0n);
        expect(Extension.isExtension(ext.script!)).toBe(true);
        const packet = Extension.fromBytes(ext.script!).getEmulatorPacket();
        expect(packet).not.toBeNull();
        expect(packet!.entries[0].vin).toBe(0);
        expect(hex.encode(packet!.entries[0].script)).toBe(
            hex.encode(
                arkade.resolveAsm(
                    paymentHoldProgram.functions.capture.arkadeScript.asm as AsmTokens,
                    { ...programArgs(terms), server: serverKey },
                ),
            ),
        );
        // RawWitness([scriptnum(30000)]) = count 1, len 2, 0x30 0x75 (LE)
        expect(Array.from(packet!.entries[0].witness!)).toEqual([0x01, 0x02, 0x30, 0x75]);

        // No CLTV on capture.
        expect(arkTx.lockTime).toBe(0);
    });

    it("reclaim sets nLockTime to releaseHeight and a non-final sequence", async () => {
        const { ark } = await stubConnect({ identityKey: terms.customerPubkey });
        const contract = contractOf(ark);

        const { arkTx } = await contract.functions
            .reclaim()
            .from(COIN)
            .to(wpToPkScript(terms.customerPayout), 50_000n)
            .build();

        expect(arkTx.lockTime).toBe(terms.releaseHeight);
        const sequence = arkTx.getInput(0).sequence;
        expect(sequence).toBeDefined();
        expect(sequence!).toBeLessThan(0xffffffff);
    });

    it("void pins the full value to the customer", async () => {
        const { ark } = await stubConnect({ identityKey: merchantPubkey });
        const contract = contractOf(ark);

        const { arkTx } = await contract.functions
            .void()
            .from(COIN)
            .to(wpToPkScript(terms.customerPayout), 50_000n)
            .build();

        const out0 = arkTx.getOutput(0);
        expect(out0.amount).toBe(50_000n);
        expect(hex.encode(out0.script!)).toBe(hex.encode(wpToPkScript(terms.customerPayout)));
        expect(arkTx.lockTime).toBe(0);
    });
});
