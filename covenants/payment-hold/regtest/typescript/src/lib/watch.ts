/**
 * Live hold lifecycle: seed from the indexer (restore after reload), then
 * follow the SSE script subscription. Spends are classified back to the
 * covenant path that executed (capture / captureAll / void / reclaim / exit)
 * by matching the revealed tapleaf against the contract's compiled leaves —
 * the serverless replacement for payment-processor webhooks.
 */
import { base64, hex } from "@scure/base";
import { Transaction, type RestIndexerProvider, type VirtualCoin, arkade } from "@arkade-os/sdk";
import type { HoldTerms } from "./terms.ts";
import { deriveHold, wpToPkScript, type DerivedHold } from "./hold.ts";

export type HoldState =
    | "unfunded"
    | "authorized"
    | "captured"
    | "voided"
    | "reclaimed"
    | "spent-unknown";

export interface HoldStatus {
    state: HoldState;
    /** The hold VTXO once funded. */
    vtxo?: VirtualCoin;
    spendTxid?: string;
    /** Sats settled to the merchant (capture/captureAll). */
    capturedAmount?: bigint;
    /** Sats returned to the customer as change (partial capture only). */
    changeAmount?: bigint;
}

export type SpendFn = "capture" | "captureAll" | "void" | "reclaim" | "exit";

/** Parse a transaction delivered by the indexer (PSBT base64 or raw hex). */
export function parseSpendTx(s: string): Transaction | null {
    try {
        return Transaction.fromPSBT(base64.decode(s));
    } catch {
        try {
            return Transaction.fromRaw(hex.decode(s), {
                allowUnknownInputs: true,
                allowUnknownOutputs: true,
            });
        } catch {
            return null;
        }
    }
}

function leafCandidates(tx: Transaction, inputIndex: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    const input = tx.getInput(inputIndex);
    // PSBT field: [controlBlock, script || leafVersion]
    for (const entry of input?.tapLeafScript ?? []) {
        const withVersion = entry[1];
        out.push(withVersion.subarray(0, withVersion.length - 1));
    }
    // Finalized script-path witness: [...stack, script, controlBlock]
    const witness = input?.finalScriptWitness;
    if (witness && witness.length >= 2) {
        out.push(witness[witness.length - 2]);
    }
    return out;
}

/**
 * Which spending path of this hold does `spendTx` execute? Matches revealed
 * tapleaves first; falls back to the payout pattern when no leaf is
 * recoverable from the transaction encoding.
 */
export function classifySpend(
    hold: DerivedHold,
    terms: HoldTerms,
    spendTx: Transaction,
): { fn: SpendFn } | null {
    const leaves = hold.contract.vtxoScript.compiled;
    for (let i = 0; i < spendTx.inputsLength; i++) {
        for (const candidate of leafCandidates(spendTx, i)) {
            const candidateHex = hex.encode(candidate);
            const match = leaves.find((l) => hex.encode(l.leafScript) === candidateHex);
            if (match) return { fn: match.name as SpendFn };
        }
    }
    // Heuristic fallback: read the payout pattern.
    const out0 = spendTx.getOutput(0);
    if (!out0?.script) return null;
    const out0Hex = hex.encode(out0.script);
    if (out0Hex === hex.encode(wpToPkScript(terms.merchantPayout))) {
        const out1 = spendTx.outputsLength > 1 ? spendTx.getOutput(1) : undefined;
        const paysCustomer =
            out1?.script &&
            hex.encode(out1.script) === hex.encode(wpToPkScript(terms.customerPayout));
        return { fn: paysCustomer ? "capture" : "captureAll" };
    }
    if (out0Hex === hex.encode(wpToPkScript(terms.customerPayout))) {
        // void and reclaim share the payout; CLTV spends carry a lock time.
        return { fn: spendTx.lockTime > 0 ? "reclaim" : "void" };
    }
    return null;
}

function statusFromSpend(tx: Transaction, fn: SpendFn, txid?: string): HoldStatus {
    const out0 = tx.getOutput(0);
    const out1 = tx.outputsLength > 1 ? tx.getOutput(1) : undefined;
    switch (fn) {
        case "capture":
            return {
                state: "captured",
                spendTxid: txid,
                capturedAmount: out0?.amount,
                changeAmount: out1?.amount,
            };
        case "captureAll":
            return { state: "captured", spendTxid: txid, capturedAmount: out0?.amount };
        case "void":
            return { state: "voided", spendTxid: txid };
        case "reclaim":
            return { state: "reclaimed", spendTxid: txid };
        case "exit":
            return { state: "spent-unknown", spendTxid: txid };
    }
}

async function resolveSpend(
    indexer: RestIndexerProvider,
    hold: DerivedHold,
    terms: HoldTerms,
    spendTxid: string | undefined,
    rawTx?: string,
): Promise<HoldStatus> {
    let tx = rawTx ? parseSpendTx(rawTx) : null;
    if (!tx && spendTxid) {
        try {
            const { txs } = await indexer.getVirtualTxs([spendTxid]);
            if (txs[0]) tx = parseSpendTx(txs[0]);
        } catch {
            // fall through to spent-unknown
        }
    }
    if (tx) {
        const cls = classifySpend(hold, terms, tx);
        if (cls) return statusFromSpend(tx, cls.fn, spendTxid);
    }
    return { state: "spent-unknown", spendTxid };
}

/**
 * Watch one hold until `signal` aborts. Emits a status on seed and on every
 * relevant SSE event. Reconnects are handled inside the SDK's subscription
 * iterator; a broken loop retries after a short delay.
 */
export async function watchHold(
    ark: arkade.Arkade,
    indexer: RestIndexerProvider,
    terms: HoldTerms,
    onUpdate: (s: HoldStatus) => void,
    signal: AbortSignal,
): Promise<void> {
    const hold = deriveHold(ark, terms);
    const scriptHex = hex.encode(hold.pkScript);

    // Seed: current chain state, so reloads recover the full lifecycle.
    try {
        const { vtxos } = await indexer.getVtxos({ scripts: [scriptHex] });
        const unspent = vtxos.find((v) => !v.isSpent);
        const spent = vtxos.find((v) => v.isSpent);
        if (unspent) {
            onUpdate({ state: "authorized", vtxo: unspent });
        } else if (spent) {
            onUpdate({ ...(await resolveSpend(indexer, hold, terms, spent.spentBy)), vtxo: spent });
        } else {
            onUpdate({ state: "unfunded" });
        }
    } catch {
        onUpdate({ state: "unfunded" });
    }

    while (!signal.aborted) {
        try {
            const subId = await indexer.subscribeForScripts([scriptHex]);
            for await (const ev of indexer.getSubscription(subId, signal)) {
                if (ev.newVtxos.length > 0) {
                    onUpdate({ state: "authorized", vtxo: ev.newVtxos[0] });
                }
                if (ev.spentVtxos.length > 0) {
                    const spent = ev.spentVtxos[0];
                    const status = await resolveSpend(
                        indexer,
                        hold,
                        terms,
                        ev.txid ?? spent.spentBy,
                        ev.tx,
                    );
                    onUpdate({ ...status, vtxo: spent });
                }
            }
        } catch {
            // transient stream failure — retry unless aborted
        }
        if (!signal.aborted) {
            await new Promise((r) => setTimeout(r, 2_000));
        }
    }
}
