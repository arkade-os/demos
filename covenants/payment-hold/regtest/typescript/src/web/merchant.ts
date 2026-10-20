/**
 * Merchant terminal: announce hold requests, watch authorizations arrive,
 * capture the metered amount (or void). No backend — the chain is the ledger,
 * the SSE indexer subscription is the webhook.
 */
import { hex } from "@scure/base";
import { DUST } from "../lib/program.ts";
import { capture, deriveHold, voidHold } from "../lib/hold.ts";
import { watchHold, type HoldStatus } from "../lib/watch.ts";
import { termsId, type HoldTerms } from "../lib/terms.ts";
import {
    HoldChannel,
    requestToHash,
    termsFromBase64,
    termsToBase64,
    type HoldRequest,
} from "./announce.ts";
import { $, copyButton, el, fmtSats, holdStore, makeLogger, shorten, stateBadge } from "./ui.ts";
import { initRole, resetRole, storageKeys, type RoleContext } from "./role.ts";

const log = makeLogger($("log"));
const channel = new HoldChannel();
const store = holdStore(storageKeys("merchant").holds);
const watching = new Set<string>();

let ctx: RoleContext;

async function main(): Promise<void> {
    try {
        ctx = await initRole("merchant");
    } catch (e) {
        log(`✗ cannot reach the regtest stack: ${(e as Error).message}`);
        log("  start it first, then reload (see README)");
        return;
    }
    $("address").textContent = ctx.address;
    $("addr-copy").replaceWith(copyButton(() => ctx.address, "copy address"));
    $("faucet-cmd").textContent = `pnpm faucet ${ctx.address} 100000`;
    refreshBalance();
    setInterval(refreshBalance, 5_000);

    $("announce").addEventListener("click", announceRequest);
    $("add-receipt").addEventListener("click", () => {
        const box = $<HTMLTextAreaElement>("receipt");
        const terms = termsFromBase64(box.value);
        if (!terms) return log("✗ that receipt did not decode");
        box.value = "";
        addHold(terms, "pasted receipt");
    });
    $("reset").addEventListener("click", () => resetRole("merchant"));

    channel.onTerms((terms) => addHold(terms, "tap received"));
    for (const encoded of store.all()) {
        const terms = termsFromBase64(encoded);
        if (terms) addHold(terms, "restored", false);
    }
    log("merchant terminal ready");
}

async function refreshBalance(): Promise<void> {
    try {
        const b = await ctx.wallet.getBalance();
        $("balance").textContent = fmtSats(b.available);
    } catch {
        /* stack briefly unreachable */
    }
}

function announceRequest(): void {
    const amount = Number($<HTMLInputElement>("amount").value);
    if (!Number.isFinite(amount) || amount <= Number(DUST)) {
        return log(`✗ hold must exceed ${DUST} sats`);
    }
    const request: HoldRequest = {
        merchantPubkeyHex: ctx.pubkeyHex,
        merchantAddress: ctx.address,
        amountSats: amount,
        label: $<HTMLInputElement>("label").value || "order",
        releaseInBlocks: Number($<HTMLInputElement>("release").value) || 20,
        exitBlocks: 144,
    };
    channel.announceRequest(request);
    const link = `${location.origin}${location.pathname.replace("merchant.html", "customer.html")}${requestToHash(request)}`;
    const linkRow = $("link-row");
    linkRow.replaceChildren(
        el("span", { class: "mono grow" }, shorten(link, 42, 8)),
        copyButton(() => link, "copy customer link"),
    );
    log(`→ announced "${request.label}" for ${fmtSats(amount)} (waiting for a tap)`);
}

function addHold(terms: HoldTerms, how: string, persist = true): void {
    const id = termsId(terms);
    if (watching.has(id)) return;
    if (ctx.pubkeyHex !== hex.encode(terms.merchantPubkey)) {
        // not addressed to this terminal
        return;
    }
    watching.add(id);
    if (persist) store.add(termsToBase64(terms));
    log(`● hold "${terms.label}" (${fmtSats(terms.holdAmount)}) — ${how}`);
    renderHold(terms);
}

function renderHold(terms: HoldTerms): void {
    const hold = deriveHold(ctx.ark, terms);
    const badge = el("span", {}, stateBadge("unfunded"));
    const info = el("span", { class: "muted" }, shorten(hold.address));
    const slider = el("input", {
        type: "range",
        min: String(Number(DUST) + 1),
        max: String(Number(terms.holdAmount)),
        value: String(Number(terms.holdAmount)),
    }) as HTMLInputElement;
    const sliderLabel = el("span", { class: "mono" }, fmtSats(terms.holdAmount));
    slider.addEventListener("input", () => (sliderLabel.textContent = fmtSats(Number(slider.value))));
    const captureBtn = el("button", { disabled: "" }, "Capture") as HTMLButtonElement;
    const voidBtn = el("button", { class: "warn", disabled: "" }, "Void") as HTMLButtonElement;

    const row = el(
        "div",
        { class: "hold" },
        el(
            "div",
            { class: "row" },
            el("strong", {}, terms.label || "order"),
            el("span", { class: "muted" }, fmtSats(terms.holdAmount)),
            badge,
        ),
        el("div", { class: "row" }, info),
        el(
            "div",
            { class: "row" },
            slider,
            sliderLabel,
            captureBtn,
            voidBtn,
        ),
    );
    $("holds").prepend(row);

    captureBtn.addEventListener("click", async () => {
        captureBtn.disabled = true;
        try {
            const res = await capture(ctx.ark, terms, BigInt(slider.value));
            log(
                `✓ captured ${fmtSats(res.captured)} (change ${fmtSats(res.change)}) tx ${shorten(res.txid)}`,
            );
            refreshBalance();
        } catch (e) {
            log(`✗ capture failed: ${(e as Error).message}`);
            captureBtn.disabled = false;
        }
    });
    voidBtn.addEventListener("click", async () => {
        voidBtn.disabled = true;
        try {
            const res = await voidHold(ctx.ark, terms);
            log(`✓ voided — hold returned to customer, tx ${shorten(res.txid)}`);
        } catch (e) {
            log(`✗ void failed: ${(e as Error).message}`);
            voidBtn.disabled = false;
        }
    });

    const abort = new AbortController();
    window.addEventListener("beforeunload", () => abort.abort());
    void watchHold(
        ctx.ark,
        ctx.indexer,
        terms,
        (s: HoldStatus) => {
            badge.replaceChildren(stateBadge(s.state));
            const active = s.state === "authorized";
            captureBtn.disabled = !active;
            voidBtn.disabled = !active;
            if (s.state === "authorized" && s.vtxo) {
                slider.max = String(s.vtxo.value);
                slider.value = String(s.vtxo.value);
                sliderLabel.textContent = fmtSats(s.vtxo.value);
                log(`● "${terms.label}" authorized (${fmtSats(s.vtxo.value)} in hold)`);
            }
            if (s.state === "captured") {
                log(
                    `● "${terms.label}" captured${s.capturedAmount ? `: ${fmtSats(s.capturedAmount)} to merchant` : ""}${s.changeAmount ? `, ${fmtSats(s.changeAmount)} change` : ""}`,
                );
                refreshBalance();
            }
            if (s.state === "voided" || s.state === "reclaimed") {
                log(`● "${terms.label}" ${s.state}`);
            }
        },
        abort.signal,
    );
}

void main();
