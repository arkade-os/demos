import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { Transaction } from "@arkade-os/sdk";
import { paymentHoldProgram } from "../src/lib/program.ts";
import { deriveHold, programArgs, wpToPkScript } from "../src/lib/hold.ts";
import { classifySpend } from "../src/lib/watch.ts";
import { COIN, customerPubkey, key, merchantPubkey, sampleTerms, stubConnect } from "./helpers.ts";

const terms = sampleTerms();

async function buildSpend(
    identityKey: Uint8Array,
    fn: "capture" | "captureAll" | "void" | "reclaim",
) {
    const { ark } = await stubConnect({ identityKey });
    const hold = deriveHold(ark, terms);
    const builder =
        fn === "capture"
            ? hold.contract.functions
                  .capture(30_000n)
                  .from(COIN)
                  .to(wpToPkScript(terms.merchantPayout), 30_000n)
                  .to(wpToPkScript(terms.customerPayout), 20_000n)
            : fn === "captureAll"
              ? hold.contract.functions
                    .captureAll()
                    .from(COIN)
                    .to(wpToPkScript(terms.merchantPayout), 50_000n)
              : hold.contract.functions[fn]()
                    .from(COIN)
                    .to(wpToPkScript(terms.customerPayout), 50_000n);
    const { arkTx } = await builder.build();
    return { hold, arkTx };
}

describe("classifySpend", () => {
    it("labels each covenant path from the revealed tapleaf", async () => {
        for (const [identityKey, fn] of [
            [merchantPubkey, "capture"],
            [merchantPubkey, "captureAll"],
            [merchantPubkey, "void"],
            [customerPubkey, "reclaim"],
        ] as const) {
            const { hold, arkTx } = await buildSpend(identityKey, fn);
            expect(classifySpend(hold, terms, arkTx), fn).toEqual({ fn });
        }
    });

    it("returns null for an unrelated transaction", async () => {
        const { ark } = await stubConnect();
        const hold = deriveHold(ark, terms);
        const tx = new Transaction({ allowUnknownOutputs: true });
        tx.addInput({ txid: COIN.txid, index: 0 });
        tx.addOutput({ script: wpToPkScript(key(0x0f)), amount: 1_000n });
        expect(classifySpend(hold, terms, tx)).toBeNull();
    });

    it("falls back to the payout heuristic when no tapleaf is present", async () => {
        const { ark } = await stubConnect();
        const hold = deriveHold(ark, terms);

        const partial = new Transaction({ allowUnknownOutputs: true });
        partial.addInput({ txid: COIN.txid, index: 0 });
        partial.addOutput({ script: wpToPkScript(terms.merchantPayout), amount: 30_000n });
        partial.addOutput({ script: wpToPkScript(terms.customerPayout), amount: 20_000n });
        expect(classifySpend(hold, terms, partial)).toEqual({ fn: "capture" });

        const full = new Transaction({ allowUnknownOutputs: true });
        full.addInput({ txid: COIN.txid, index: 0 });
        full.addOutput({ script: wpToPkScript(terms.merchantPayout), amount: 50_000n });
        expect(classifySpend(hold, terms, full)).toEqual({ fn: "captureAll" });

        const voided = new Transaction({ allowUnknownOutputs: true });
        voided.addInput({ txid: COIN.txid, index: 0 });
        voided.addOutput({ script: wpToPkScript(terms.customerPayout), amount: 50_000n });
        expect(classifySpend(hold, terms, voided)).toEqual({ fn: "void" });

        const reclaimed = new Transaction({ allowUnknownOutputs: true, lockTime: 1_000 });
        reclaimed.addInput({ txid: COIN.txid, index: 0, sequence: 0xfffffffe });
        reclaimed.addOutput({ script: wpToPkScript(terms.customerPayout), amount: 50_000n });
        expect(classifySpend(hold, terms, reclaimed)).toEqual({ fn: "reclaim" });
    });
});
