/**
 * Hold terms: everything both parties need to derive the covenant address and
 * drive the lifecycle. Travels three ways, in order of preference:
 *   1. BroadcastChannel (same machine, demo convenience)
 *   2. payment link (`customer.html#terms=<base64url>`)
 *   3. TLV extension packet on the funding transaction (on-chain restore/audit)
 *
 * Server/emulator keys are deliberately NOT part of the terms — they are
 * fetched at connect time, so a regtest reset never bakes stale keys into
 * shared state.
 */
import { base64urlnopad, hex } from "@scure/base";
import type { ExtensionPacket } from "@arkade-os/sdk";

export interface HoldTerms {
    /** x-only key that signs capture / captureAll / void / exit. */
    merchantPubkey: Uint8Array;
    /** x-only key that signs reclaim. */
    customerPubkey: Uint8Array;
    /** 32-byte witness program of the merchant's ark address. */
    merchantPayout: Uint8Array;
    /** 32-byte witness program of the customer's ark address. */
    customerPayout: Uint8Array;
    /** 8 random bytes; makes the covenant address unique per hold. */
    orderSalt: Uint8Array;
    /** Absolute block height after which the customer can reclaim (CLTV). */
    releaseHeight: number;
    /** CSV blocks for the merchant's unilateral exit leaf. */
    exitBlocks: number;
    /** Requested hold in sats (informational; the funded VTXO value is authoritative). */
    holdAmount: bigint;
    /** Order id / memo, ≤ 64 UTF-8 bytes. */
    label: string;
}

/** Custom extension-packet type tag (0 = asset, 1 = emulator are reserved). */
export const TERMS_PACKET_TYPE = 0x50;

const VERSION = 1;
const LABEL_MAX = 64;
// ver(1) + 4×32 keys/payouts + salt(8) + height(4) + exit(2) + amount(8)
const FIXED_LEN = 1 + 32 * 4 + 8 + 4 + 2 + 8;

function check32(name: string, b: Uint8Array): void {
    if (b.length !== 32) throw new Error(`${name} must be 32 bytes, got ${b.length}`);
}

export function encodeTerms(t: HoldTerms): Uint8Array {
    check32("merchantPubkey", t.merchantPubkey);
    check32("customerPubkey", t.customerPubkey);
    check32("merchantPayout", t.merchantPayout);
    check32("customerPayout", t.customerPayout);
    if (t.orderSalt.length !== 8) throw new Error("orderSalt must be 8 bytes");
    if (t.releaseHeight < 0 || t.releaseHeight > 0xffffffff)
        throw new Error("releaseHeight out of range");
    if (t.exitBlocks < 0 || t.exitBlocks > 0xffff) throw new Error("exitBlocks out of range");
    if (t.holdAmount < 0n || t.holdAmount > 0xffffffffffffffffn)
        throw new Error("holdAmount out of range");
    const label = new TextEncoder().encode(t.label);
    if (label.length > LABEL_MAX) throw new Error(`label exceeds ${LABEL_MAX} bytes`);

    const out = new Uint8Array(FIXED_LEN + label.length);
    const dv = new DataView(out.buffer);
    let o = 0;
    out[o++] = VERSION;
    out.set(t.merchantPubkey, o); o += 32;
    out.set(t.customerPubkey, o); o += 32;
    out.set(t.merchantPayout, o); o += 32;
    out.set(t.customerPayout, o); o += 32;
    out.set(t.orderSalt, o); o += 8;
    dv.setUint32(o, t.releaseHeight, true); o += 4;
    dv.setUint16(o, t.exitBlocks, true); o += 2;
    dv.setBigUint64(o, t.holdAmount, true); o += 8;
    out.set(label, o);
    return out;
}

export function decodeTerms(b: Uint8Array): HoldTerms {
    if (b.length < FIXED_LEN) throw new Error(`terms too short: ${b.length} < ${FIXED_LEN}`);
    if (b[0] !== VERSION) throw new Error(`unsupported terms version ${b[0]}`);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 1;
    const merchantPubkey = b.slice(o, o + 32); o += 32;
    const customerPubkey = b.slice(o, o + 32); o += 32;
    const merchantPayout = b.slice(o, o + 32); o += 32;
    const customerPayout = b.slice(o, o + 32); o += 32;
    const orderSalt = b.slice(o, o + 8); o += 8;
    const releaseHeight = dv.getUint32(o, true); o += 4;
    const exitBlocks = dv.getUint16(o, true); o += 2;
    const holdAmount = dv.getBigUint64(o, true); o += 8;
    const label = new TextDecoder().decode(b.slice(o));
    return {
        merchantPubkey, customerPubkey, merchantPayout, customerPayout,
        orderSalt, releaseHeight, exitBlocks, holdAmount, label,
    };
}

/** The terms as an extension packet for the funding transaction. */
export class TermsPacket implements ExtensionPacket {
    private readonly terms: HoldTerms;
    constructor(terms: HoldTerms) {
        this.terms = terms;
    }
    type(): number {
        return TERMS_PACKET_TYPE;
    }
    serialize(): Uint8Array {
        return encodeTerms(this.terms);
    }
}

/** `${base}customer.html#terms=<base64url>` — the cross-device handoff. */
export function termsToLink(t: HoldTerms, base: string): string {
    return `${base}customer.html#terms=${base64urlnopad.encode(encodeTerms(t))}`;
}

/** Parse `#terms=…` from a location hash; null when absent or malformed. */
export function termsFromHash(hash: string): HoldTerms | null {
    const m = /[#&]terms=([A-Za-z0-9_-]+)/.exec(hash);
    if (!m) return null;
    try {
        return decodeTerms(base64urlnopad.decode(m[1]));
    } catch {
        return null;
    }
}

/** Stable id for UI lists and storage keys. */
export function termsId(t: HoldTerms): string {
    return hex.encode(t.orderSalt);
}
