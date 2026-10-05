/**
 * Customer wallet: receive a hold request, "tap" to authorize (fund the
 * covenant), watch the outcome, and reclaim after the timelock if the
 * merchant never settles.
 */
import { hex } from "@scure/base";
import { chainTipHeight } from "../lib/client.ts";
import { createHold, deriveHold, fundHold, reclaim } from "../lib/hold.ts";
import { watchHold, type HoldStatus } from "../lib/watch.ts";
import { termsId, type HoldTerms } from "../lib/terms.ts";
import {
    HoldChannel,
    requestFromHash,
    termsFromBase64,
    termsToBase64,
    type HoldRequest,
} from "./announce.ts";
import { $, copyButton, el, fmtSats, holdStore, makeLogger, shorten, stateBadge } from "./ui.ts";
import { initRole, resetRole, storageKeys, type RoleContext } from "./role.ts";

const log = makeLogger($("log"));
const channel = new HoldChannel();
const store = holdStore(storageKeys("customer").holds);
const watching = new Set<string>();

let ctx: RoleContext;
let tip = 0;

async function main(): Promise<void> {
    try {
        ctx = await initRole("customer");
    } catch (e) {
        log(`✗ cannot reach the regtest stack: ${(e as Error).message}`);
        log("  start it first, then reload (see README)");
        return;
    }
    $("address").textContent = ctx.address;
    $("addr-copy").replaceWith(copyButton(() => ctx.address, "copy address"));
    $("faucet-cmd").textContent = `pnpm faucet ${ctx.address} 200000`;
    refreshBalance();
    setInterval(refreshBalance, 5_000);
    void refreshTip();
    setInterval(refreshTip, 10_000);

    $("reset").addEventListener("click", () => resetRole("customer"));

    channel.onRequest(showRequest);
    const fromHash = requestFromHash(location.hash);
    if (fromHash) showRequest(fromHash);

    for (const encoded of store.all()) {
        const terms = termsFromBase64(encoded);
        if (terms) trackHold(terms, false);
    }
    log("customer wallet ready — waiting for a hold request");
}

async function refreshBalance(): Promise<void> {
    try {
        const b = await ctx.wallet.getBalance();
        $("balance").textContent = fmtSats(b.available);
    } catch {
        /* transient */
    }
}

async function refreshTip(): Promise<void> {
    try {
        tip = await chainTipHeight();
        $("tip").textContent = String(tip);
    } catch {
        /* transient */
    }
}

function showRequest(request: HoldRequest): void {
    const tapBtn = el("button", {}, `⛽ Tap to authorize ${fmtSats(request.amountSats)}`);
    const card = el(
        "div",
        { class: "hold" },
        el(
            "div",
            { class: "row" },
            el("strong", {}, request.label),
            el("span", { class: "muted" }, `merchant ${shorten(request.merchantAddress)}`),
        ),
        el(
            "div",
            { class: "row" },
            el(
                "span",
                { class: "muted" },
                `hold ${fmtSats(request.amountSats)} · auto-release after ${request.releaseInBlocks} blocks`,
            ),
        ),
        el("div", { class: "row" }, tapBtn),
    );
    $("request").replaceChildren(card);
    tapBtn.addEventListener("click", async () => {
        tapBtn.setAttribute("disabled", "");
        tapBtn.textContent = "authorizing…";
        try {
            await authorize(request);
            $("request").replaceChildren();
        } catch (e) {
            log(`✗ authorize failed: ${(e as Error).message}`);
            tapBtn.removeAttribute("disabled");
            tapBtn.textContent = `⛽ Tap to authorize ${fmtSats(request.amountSats)}`;
        }
    });
    log(`← hold request "${request.label}" for ${fmtSats(request.amountSats)}`);
}

async function authorize(request: HoldRequest): Promise<void> {
    const terms = await createHold({
        merchantPubkey: hex.decode(request.merchantPubkeyHex),
        customerPubkey: ctx.pubkey,
        merchantAddress: request.merchantAddress,
        customerAddress: ctx.address,
        amount: BigInt(request.amountSats),
        label: request.label,
        releaseInBlocks: request.releaseInBlocks,
        exitBlocks: request.exitBlocks,
    });
    const hold = deriveHold(ctx.ark, terms);
    const funded = await fundHold(ctx.wallet, terms, hold.address);
    log(
        `✓ authorized ${fmtSats(terms.holdAmount)} — tx ${shorten(funded.txid)}` +
            (funded.termsEmbedded ? " (terms embedded on-chain)" : " (terms NOT embedded — fallback send)"),
    );
    channel.announceTerms(terms);
    const receipt = termsToBase64(terms);
    const receiptRow = $("receipt-row");
    receiptRow.replaceChildren(
        el("span", { class: "muted" }, "receipt for the merchant (cross-device): "),
        copyButton(() => receipt, "copy receipt"),
    );
    trackHold(terms);
    refreshBalance();
}

function trackHold(terms: HoldTerms, persist = true): void {
    const id = termsId(terms);
    if (watching.has(id)) return;
    watching.add(id);
    if (persist) store.add(termsToBase64(terms));

    const badge = el("span", {}, stateBadge("unfunded"));
    const releaseInfo = el("span", { class: "muted" }, `releases at height ${terms.releaseHeight}`);
    const reclaimBtn = el("button", { class: "warn", disabled: "" }, "Reclaim") as HTMLButtonElement;
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
        el("div", { class: "row" }, releaseInfo, reclaimBtn),
    );
    $("holds").prepend(row);

    let state: HoldStatus["state"] = "unfunded";
    const updateReclaim = () => {
        const blocksLeft = terms.releaseHeight - tip;
        releaseInfo.textContent =
            blocksLeft > 0
                ? `releases at height ${terms.releaseHeight} (${blocksLeft} block(s) left)`
                : `releasable since height ${terms.releaseHeight}`;
        reclaimBtn.disabled = !(state === "authorized" && blocksLeft <= 0);
    };
    setInterval(updateReclaim, 2_000);

    reclaimBtn.addEventListener("click", async () => {
        reclaimBtn.disabled = true;
        try {
            const res = await reclaim(ctx.ark, terms);
            log(`✓ reclaimed the hold — tx ${shorten(res.txid)}`);
            refreshBalance();
        } catch (e) {
            log(`✗ reclaim failed: ${(e as Error).message}`);
            reclaimBtn.disabled = false;
        }
    });

    const abort = new AbortController();
    window.addEventListener("beforeunload", () => abort.abort());
    void watchHold(
        ctx.ark,
        ctx.indexer,
        terms,
        (s: HoldStatus) => {
            state = s.state;
            badge.replaceChildren(stateBadge(s.state));
            updateReclaim();
            if (s.state === "captured") {
                log(
                    `● "${terms.label}" settled by the merchant` +
                        (s.changeAmount ? ` — ${fmtSats(s.changeAmount)} change returned` : ""),
                );
                refreshBalance();
            }
            if (s.state === "voided") {
                log(`● "${terms.label}" voided — full hold returned`);
                refreshBalance();
            }
            if (s.state === "reclaimed") refreshBalance();
        },
        abort.signal,
    );
}

void main();
