/**
 * Hold handoff between the two browser contexts, no server involved:
 * - BroadcastChannel for same-machine tabs (the "tap");
 * - URL-hash / pasted payloads for cross-device;
 * - the on-chain TLV packet remains the restore/audit channel (see terms.ts).
 *
 * Two message kinds flow:
 *   request  merchant → customer: the terminal shows what to authorize
 *   terms    customer → merchant: the completed, funded hold terms
 */
import { base64urlnopad } from "@scure/base";
import { decodeTerms, encodeTerms, type HoldTerms } from "../lib/terms.ts";

export interface HoldRequest {
    merchantPubkeyHex: string;
    merchantAddress: string;
    amountSats: number;
    label: string;
    releaseInBlocks: number;
    exitBlocks: number;
}

type Message =
    | { kind: "request"; request: HoldRequest }
    | { kind: "terms"; terms: string /* base64url(encodeTerms) */ };

const CHANNEL = "arkade-payment-hold";

export function termsToBase64(t: HoldTerms): string {
    return base64urlnopad.encode(encodeTerms(t));
}

export function termsFromBase64(s: string): HoldTerms | null {
    try {
        return decodeTerms(base64urlnopad.decode(s.trim()));
    } catch {
        return null;
    }
}

export function requestToHash(r: HoldRequest): string {
    return `#request=${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(r)))}`;
}

export function requestFromHash(hash: string): HoldRequest | null {
    const m = /[#&]request=([A-Za-z0-9_-]+)/.exec(hash);
    if (!m) return null;
    try {
        const r = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(m[1])));
        if (typeof r.merchantPubkeyHex !== "string" || typeof r.merchantAddress !== "string")
            return null;
        return r as HoldRequest;
    } catch {
        return null;
    }
}

export class HoldChannel {
    private readonly bc = new BroadcastChannel(CHANNEL);

    announceRequest(request: HoldRequest): void {
        this.bc.postMessage({ kind: "request", request } satisfies Message);
    }

    announceTerms(terms: HoldTerms): void {
        this.bc.postMessage({ kind: "terms", terms: termsToBase64(terms) } satisfies Message);
    }

    onRequest(cb: (r: HoldRequest) => void): void {
        this.bc.addEventListener("message", (e: MessageEvent<Message>) => {
            if (e.data?.kind === "request") cb(e.data.request);
        });
    }

    onTerms(cb: (t: HoldTerms) => void): void {
        this.bc.addEventListener("message", (e: MessageEvent<Message>) => {
            if (e.data?.kind === "terms") {
                const t = termsFromBase64(e.data.terms);
                if (t) cb(t);
            }
        });
    }

    close(): void {
        this.bc.close();
    }
}
