import { describe, it, expect } from "vitest";
import { arkade } from "@arkade-os/sdk";
import { paymentHoldProgram, type AsmTokens } from "../src/lib/program.ts";
import programJson from "../contract/payment-hold.program.json";

const fullArgs = {
    merchantPubkey: new Uint8Array(32).fill(0x11),
    customerPubkey: new Uint8Array(32).fill(0x22),
    merchantPayout: new Uint8Array(32).fill(0x33),
    customerPayout: new Uint8Array(32).fill(0x44),
    orderSalt: new Uint8Array(8).fill(0x55),
    releaseHeight: 500n,
    exitBlocks: 144n,
    server: new Uint8Array(32).fill(0x66),
};

describe("payment-hold program", () => {
    it("validates with a full binding", () => {
        expect(() => arkade.validateProgram(paymentHoldProgram, fullArgs)).not.toThrow();
    });

    it("rejects a missing binding", () => {
        const { server: _server, ...missing } = fullArgs;
        expect(() => arkade.validateProgram(paymentHoldProgram, missing)).toThrow();
    });

    it("rejects a wrong-length pubkey", () => {
        expect(() =>
            arkade.validateProgram(paymentHoldProgram, {
                ...fullArgs,
                merchantPubkey: new Uint8Array(31),
            }),
        ).toThrow();
    });

    it("JSON artifact parses to the exact TS literal", () => {
        // JSON imports widen "pubkey"/"int" to string; parseArtifact validates at runtime.
        const parsed = arkade.parseArtifact(programJson as Parameters<typeof arkade.parseArtifact>[0]);
        expect(parsed).toEqual(paymentHoldProgram);
    });

    it("artifact JSON round-trips through stringify/parse", () => {
        const once = arkade.stringifyArtifact(paymentHoldProgram);
        const twice = arkade.stringifyArtifact(arkade.parseArtifact(JSON.parse(once)));
        expect(twice).toBe(once);
    });

    it("capture covenant resolves to concrete script bytes", () => {
        const bytes = arkade.resolveAsm(
            paymentHoldProgram.functions.capture.arkadeScript.asm as AsmTokens,
            fullArgs,
        );
        expect(bytes.length).toBeGreaterThan(0);
        // round-trip through the decoder: every token must be a known opcode or push
        const asm = arkade.bytesToASM(bytes);
        expect(asm).toContain("INSPECTOUTPUTVALUE");
        expect(asm).toContain("PUSHCURRENTINPUTINDEX");
        expect(asm).toContain("ADD");
    });
});
