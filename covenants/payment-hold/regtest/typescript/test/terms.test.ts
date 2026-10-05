import { describe, it, expect } from "vitest";
import { Extension } from "@arkade-os/sdk";
import {
    decodeTerms,
    encodeTerms,
    TermsPacket,
    TERMS_PACKET_TYPE,
    termsFromHash,
    termsToLink,
    type HoldTerms,
} from "../src/lib/terms.ts";

function sampleTerms(label = "pump-42"): HoldTerms {
    return {
        merchantPubkey: new Uint8Array(32).fill(1),
        customerPubkey: new Uint8Array(32).fill(2),
        merchantPayout: new Uint8Array(32).fill(3),
        customerPayout: new Uint8Array(32).fill(4),
        orderSalt: new Uint8Array(8).fill(5),
        releaseHeight: 1234,
        exitBlocks: 144,
        holdAmount: 100_000n,
        label,
    };
}

describe("terms codec", () => {
    it("round-trips", () => {
        const t = sampleTerms();
        expect(decodeTerms(encodeTerms(t))).toEqual(t);
    });

    it("round-trips an empty label", () => {
        const t = sampleTerms("");
        expect(decodeTerms(encodeTerms(t))).toEqual(t);
    });

    it("round-trips a multi-byte UTF-8 label", () => {
        const t = sampleTerms("⛽ pump #7");
        expect(decodeTerms(encodeTerms(t))).toEqual(t);
    });

    it("rejects an oversized label", () => {
        expect(() => encodeTerms(sampleTerms("x".repeat(65)))).toThrow(/label/);
    });

    it("rejects a wrong-length salt", () => {
        expect(() => encodeTerms({ ...sampleTerms(), orderSalt: new Uint8Array(7) })).toThrow(
            /orderSalt/,
        );
    });

    it("rejects truncated bytes and unknown versions", () => {
        expect(() => decodeTerms(new Uint8Array(10))).toThrow(/too short/);
        const bad = encodeTerms(sampleTerms());
        bad[0] = 9;
        expect(() => decodeTerms(bad)).toThrow(/version/);
    });

    it("survives an Extension OP_RETURN round-trip as an unknown packet", () => {
        const t = sampleTerms();
        const out = Extension.create([new TermsPacket(t)]).txOut();
        expect(Extension.isExtension(out.script)).toBe(true);
        const packet = Extension.fromBytes(out.script).getPacketByType(TERMS_PACKET_TYPE);
        expect(packet).not.toBeNull();
        expect(decodeTerms(packet!.serialize())).toEqual(t);
    });

    it("payment link round-trips through the location hash", () => {
        const t = sampleTerms();
        const link = termsToLink(t, "http://localhost:5173/");
        const hash = new URL(link).hash;
        expect(termsFromHash(hash)).toEqual(t);
        expect(termsFromHash("#nope")).toBeNull();
    });
});
