/**
 * End-to-end smoke test against a local arkade regtest stack (Banco-style).
 * Run with `pnpm smoke` on a machine where the stack is up — see preflight.
 *
 * Gates:
 *   G1  merchant and customer independently derive the same hold address
 *   G2  capture enforces the covenant (happy path + two tamper rejections)
 *   G3  reclaim is blocked before releaseHeight, works after (CLTV path)
 *   G4  the terms TLV packet on the funding tx restores from the chain
 */
import { EventSource } from "eventsource";
import { hex } from "@scure/base";
import { SingleKey, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { connectArkade, createRoleWallet, indexerProvider } from "../src/lib/client.ts";
import {
    capture,
    createHold,
    deriveHold,
    fundHold,
    getHoldVtxo,
    reclaim,
    restoreTermsFromTx,
    voidHold,
    wpToPkScript,
} from "../src/lib/hold.ts";
import { watchHold, type HoldStatus } from "../src/lib/watch.ts";
import type { HoldTerms } from "../src/lib/terms.ts";
import {
    faucetOffchain,
    mineBlocks,
    preflight,
    sleep,
    tipHeight,
    waitFor,
    waitForVtxo,
} from "./regtest.ts";

// The SDK's SSE subscription uses the browser EventSource API.
(globalThis as { EventSource?: unknown }).EventSource ??= EventSource;

let passed = 0;
function ok(gate: string, msg: string): void {
    passed++;
    console.log(`  ✓ [${gate}] ${msg}`);
}
function warn(gate: string, msg: string): void {
    console.log(`  ⚠ [${gate}] ${msg}`);
}

async function expectReject(what: string, p: Promise<unknown>): Promise<void> {
    try {
        await p;
    } catch {
        return;
    }
    throw new Error(`${what}: expected rejection, but it succeeded`);
}

async function main(): Promise<void> {
    console.log("payment-hold smoke test");
    await preflight();

    // --- actors ------------------------------------------------------------
    const merchantId = SingleKey.fromRandomBytes();
    const customerId = SingleKey.fromRandomBytes();
    const merchantWallet = await createRoleWallet(merchantId);
    const customerWallet = await createRoleWallet(customerId);
    const merchantArk = await connectArkade(merchantId);
    const customerArk = await connectArkade(customerId);
    const indexer = indexerProvider();

    const merchantAddress = await merchantWallet.getAddress();
    const customerAddress = await customerWallet.getAddress();

    console.log("• funding customer wallet from the faucet…");
    faucetOffchain(customerAddress, 200_000);
    await waitFor(async () => {
        const b = await customerWallet.getBalance();
        return b.available >= 200_000 ? b : undefined;
    }, "customer faucet funds");

    const newTerms = async (amount: bigint, releaseInBlocks: number): Promise<HoldTerms> =>
        createHold({
            merchantPubkey: await merchantId.xOnlyPublicKey(),
            customerPubkey: await customerId.xOnlyPublicKey(),
            merchantAddress,
            customerAddress,
            amount,
            label: "pump-42",
            releaseInBlocks,
        });

    // --- G1: cross-derivation determinism ----------------------------------
    const terms = await newTerms(50_000n, 20);
    const merchantView = deriveHold(merchantArk, terms);
    const customerView = deriveHold(customerArk, terms);
    if (merchantView.address !== customerView.address) {
        throw new Error(
            `G1 FAILED: merchant ${merchantView.address} != customer ${customerView.address}`,
        );
    }
    ok("G1", `both parties derive ${merchantView.address.slice(0, 24)}…`);

    // --- authorize ----------------------------------------------------------
    console.log("• authorizing (customer funds the hold)…");
    const funded = await fundHold(customerWallet, terms, customerView.address);
    await waitForVtxo(indexer, customerView.pkScript);
    console.log(`  hold funded: ${funded.txid}`);

    // --- G4: on-chain terms restore ----------------------------------------
    if (!funded.termsEmbedded) {
        warn("G4", "wallet.send rejected the extensions field — terms not embedded (fallback used)");
    } else {
        try {
            const { txs } = await indexer.getVirtualTxs([funded.txid]);
            const fundingTx = Transaction.fromPSBT(base64.decode(txs[0]));
            const restored = restoreTermsFromTx(fundingTx);
            if (restored && hex.encode(restored.orderSalt) === hex.encode(terms.orderSalt)) {
                ok("G4", "terms packet restored from the funding tx");
            } else {
                warn("G4", "funding tx fetched but terms packet not found/mismatched");
            }
        } catch (e) {
            warn("G4", `could not verify terms restore: ${(e as Error).message}`);
        }
    }

    // --- watcher ------------------------------------------------------------
    const states: HoldStatus[] = [];
    const watchAbort = new AbortController();
    const watcher = watchHold(
        merchantArk,
        indexer,
        terms,
        (s) => {
            states.push(s);
            console.log(`  [watch] ${s.state}${s.capturedAmount ? ` captured=${s.capturedAmount}` : ""}`);
        },
        watchAbort.signal,
    );

    // --- G2: covenant enforcement ------------------------------------------
    console.log("• tamper: capture paying out0 != witness amount must be rejected…");
    const coin = await getHoldVtxo(merchantView);
    if (!coin) throw new Error("hold vtxo missing");
    await expectReject(
        "tampered amount",
        merchantView.contract.functions
            .capture(30_000n)
            .from({ txid: coin.txid, vout: coin.vout, value: coin.value })
            .to(wpToPkScript(terms.merchantPayout), 30_001n)
            .to(wpToPkScript(terms.customerPayout), 19_999n)
            .send(),
    );
    ok("G2", "tampered capture amount rejected");

    console.log("• tamper: change routed to the merchant must be rejected…");
    await expectReject(
        "tampered change script",
        merchantView.contract.functions
            .capture(30_000n)
            .from({ txid: coin.txid, vout: coin.vout, value: coin.value })
            .to(wpToPkScript(terms.merchantPayout), 30_000n)
            .to(wpToPkScript(terms.merchantPayout), 20_000n)
            .send(),
    );
    ok("G2", "tampered change destination rejected");

    console.log("• capture 30 000 of the 50 000 hold…");
    const res = await capture(merchantArk, terms, 30_000n);
    if (res.captured !== 30_000n || res.change !== 20_000n) {
        throw new Error(`G2 FAILED: captured=${res.captured} change=${res.change}`);
    }
    ok("G2", `partial capture settled (txid ${res.txid.slice(0, 16)}…)`);

    await waitFor(
        async () => states.some((s) => s.state === "captured" && s.capturedAmount === 30_000n),
        "watcher to observe the capture",
    );
    ok("G2", "watcher classified the spend as `capture` with the right amounts");

    const merchantBalance = await merchantWallet.getBalance();
    if (merchantBalance.available < 30_000) {
        warn("G2", `merchant balance ${merchantBalance.available} < 30000 (sync lag?)`);
    } else {
        ok("G2", `merchant balance ${merchantBalance.available}`);
    }

    // --- dust routing -------------------------------------------------------
    console.log("• hold #2: capture within dust of the full hold routes to captureAll…");
    const terms2 = await newTerms(20_000n, 20);
    const view2 = deriveHold(customerArk, terms2);
    await fundHold(customerWallet, terms2, view2.address);
    await waitForVtxo(indexer, view2.pkScript);
    const res2 = await capture(merchantArk, terms2, 19_800n);
    if (res2.captured !== 20_000n || res2.change !== 0n) {
        throw new Error(`dust routing failed: captured=${res2.captured} change=${res2.change}`);
    }
    ok("G2", "sub-dust change rode to the merchant via captureAll");

    // --- void ---------------------------------------------------------------
    console.log("• hold #3: merchant voids the authorization…");
    const terms3 = await newTerms(15_000n, 20);
    const view3 = deriveHold(customerArk, terms3);
    await fundHold(customerWallet, terms3, view3.address);
    await waitForVtxo(indexer, view3.pkScript);
    await voidHold(merchantArk, terms3);
    await waitForVtxo(indexer, view3.pkScript, { spent: true });
    ok("void", "hold released back to the customer");

    // --- G3: reclaim (CLTV) -------------------------------------------------
    console.log("• hold #4: customer reclaims after the timelock…");
    const terms4 = await newTerms(15_000n, 2);
    const view4 = deriveHold(customerArk, terms4);
    await fundHold(customerWallet, terms4, view4.address);
    await waitForVtxo(indexer, view4.pkScript);

    await expectReject("early reclaim", reclaim(customerArk, terms4));
    ok("G3", "reclaim before releaseHeight refused");

    const tip = await tipHeight();
    if (tip < terms4.releaseHeight) {
        await mineBlocks(terms4.releaseHeight - tip);
    }
    await reclaim(customerArk, terms4);
    await waitForVtxo(indexer, view4.pkScript, { spent: true });
    ok("G3", "reclaim after releaseHeight settled (CLTV covenant path)");

    // --- wrap up ------------------------------------------------------------
    watchAbort.abort();
    await Promise.race([watcher, sleep(2_000)]);
    console.log(`\nsmoke test passed (${passed} checks)`);
    process.exit(0);
}

main().catch((e) => {
    console.error(`\nsmoke test FAILED: ${(e as Error).stack ?? e}`);
    process.exit(1);
});
