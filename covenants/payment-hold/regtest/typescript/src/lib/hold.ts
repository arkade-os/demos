/**
 * Hold lifecycle operations: create/derive, authorize (fund), capture, void,
 * reclaim, and on-chain restore of the terms packet.
 */
import { arkade, ArkAddress, Extension, Transaction, Wallet, type VirtualCoin } from "@arkade-os/sdk";
import { DUST, paymentHoldProgram, type ParamValues } from "./program.ts";
import { encodeTerms, TERMS_PACKET_TYPE, decodeTerms, type HoldTerms } from "./terms.ts";
import { chainTipHeight } from "./client.ts";

export interface DerivedHold {
    contract: arkade.ArkadeContract<typeof paymentHoldProgram>;
    address: string;
    pkScript: Uint8Array;
}

/** 32-byte witness program of an ark address. */
export function payoutOf(arkAddress: string): Uint8Array {
    return ArkAddress.decode(arkAddress).pkScript.subarray(2);
}

/** v1 taproot output script for a 32-byte witness program. */
export function wpToPkScript(wp: Uint8Array): Uint8Array {
    if (wp.length !== 32) throw new Error("witness program must be 32 bytes");
    return new Uint8Array([0x51, 0x20, ...wp]);
}

export async function createHold(opts: {
    merchantPubkey: Uint8Array;
    customerPubkey: Uint8Array;
    merchantAddress: string;
    customerAddress: string;
    amount: bigint;
    label?: string;
    /** releaseHeight = current tip + this. Default 20 blocks. */
    releaseInBlocks?: number;
    exitBlocks?: number;
}): Promise<HoldTerms> {
    if (opts.amount <= DUST) throw new Error(`hold must exceed ${DUST} sats`);
    const salt = new Uint8Array(8);
    crypto.getRandomValues(salt);
    const tip = await chainTipHeight();
    return {
        merchantPubkey: opts.merchantPubkey,
        customerPubkey: opts.customerPubkey,
        merchantPayout: payoutOf(opts.merchantAddress),
        customerPayout: payoutOf(opts.customerAddress),
        orderSalt: salt,
        releaseHeight: tip + (opts.releaseInBlocks ?? 20),
        exitBlocks: opts.exitBlocks ?? 144,
        holdAmount: opts.amount,
        label: opts.label ?? "",
    };
}

export function programArgs(terms: HoldTerms): ParamValues {
    return {
        merchantPubkey: terms.merchantPubkey,
        customerPubkey: terms.customerPubkey,
        merchantPayout: terms.merchantPayout,
        customerPayout: terms.customerPayout,
        orderSalt: terms.orderSalt,
        releaseHeight: BigInt(terms.releaseHeight),
        exitBlocks: BigInt(terms.exitBlocks),
        // `server` is auto-bound by Arkade.contract from the connected client.
    };
}

export function deriveHold(ark: arkade.Arkade, terms: HoldTerms): DerivedHold {
    const contract = ark.contract(paymentHoldProgram, programArgs(terms));
    return { contract, address: contract.address, pkScript: contract.pkScript };
}

/**
 * Authorize: fund the hold address for the full hold amount, attaching the
 * terms as a TLV extension packet so the hold is restorable from the chain.
 * `Recipient.extensions` is an untested SDK surface — on rejection we retry
 * as a plain send and report `termsEmbedded: false`.
 */
export async function fundHold(
    wallet: Wallet,
    terms: HoldTerms,
    address: string,
): Promise<{ txid: string; termsEmbedded: boolean }> {
    const amount = Number(terms.holdAmount);
    try {
        const txid = await wallet.send({
            address,
            amount,
            extensions: [{ type: TERMS_PACKET_TYPE, payload: encodeTerms(terms) }],
        });
        return { txid, termsEmbedded: true };
    } catch {
        const txid = await wallet.send({ address, amount });
        return { txid, termsEmbedded: false };
    }
}

export async function getHoldVtxo(
    hold: DerivedHold,
): Promise<VirtualCoin | undefined> {
    const coins = await hold.contract.getUtxos();
    return coins.find((c) => !c.isSpent) ?? coins[0];
}

function asUtxo(coin: VirtualCoin): arkade.Utxo {
    return { txid: coin.txid, vout: coin.vout, value: coin.value };
}

/**
 * Capture `amount` of the hold. Routes to `captureAll` when the change would
 * be sub-dust (the remainder rides to the merchant, matching the reference
 * contract's policy).
 */
export async function capture(
    ark: arkade.Arkade,
    terms: HoldTerms,
    amount: bigint,
): Promise<arkade.ArkadeSpendResult & { captured: bigint; change: bigint }> {
    if (amount <= DUST) throw new Error(`capture must exceed ${DUST} sats`);
    const hold = deriveHold(ark, terms);
    const coin = await getHoldVtxo(hold);
    if (!coin) throw new Error("hold is not funded");
    const held = BigInt(coin.value);
    if (amount > held) throw new Error(`capture ${amount} exceeds hold ${held}`);

    const change = held - amount;
    if (change <= DUST) {
        const res = await hold.contract.functions
            .captureAll()
            .from(asUtxo(coin))
            .to(wpToPkScript(terms.merchantPayout), held)
            .send();
        return { ...res, captured: held, change: 0n };
    }
    const res = await hold.contract.functions
        .capture(amount)
        .from(asUtxo(coin))
        .to(wpToPkScript(terms.merchantPayout), amount)
        .to(wpToPkScript(terms.customerPayout), change)
        .send();
    return { ...res, captured: amount, change };
}

/** Void: merchant releases the full hold back to the customer immediately. */
export async function voidHold(
    ark: arkade.Arkade,
    terms: HoldTerms,
): Promise<arkade.ArkadeSpendResult> {
    const hold = deriveHold(ark, terms);
    const coin = await getHoldVtxo(hold);
    if (!coin) throw new Error("hold is not funded");
    return hold.contract.functions
        .void()
        .from(asUtxo(coin))
        .to(wpToPkScript(terms.customerPayout), BigInt(coin.value))
        .send();
}

/** Reclaim: after releaseHeight the customer recovers the hold (CLTV). */
export async function reclaim(
    ark: arkade.Arkade,
    terms: HoldTerms,
): Promise<arkade.ArkadeSpendResult> {
    const tip = await chainTipHeight();
    if (tip < terms.releaseHeight) {
        throw new Error(
            `hold releases at height ${terms.releaseHeight}, chain is at ${tip} — ` +
                `${terms.releaseHeight - tip} block(s) to go`,
        );
    }
    const hold = deriveHold(ark, terms);
    const coin = await getHoldVtxo(hold);
    if (!coin) throw new Error("hold is not funded");
    return hold.contract.functions
        .reclaim()
        .from(asUtxo(coin))
        .to(wpToPkScript(terms.customerPayout), BigInt(coin.value))
        .send();
}

/** Recover the terms packet from a funding transaction (on-chain restore). */
export function restoreTermsFromTx(tx: Transaction): HoldTerms | null {
    try {
        const packet = Extension.fromTx(tx).getPacketByType(TERMS_PACKET_TYPE);
        return packet ? decodeTerms(packet.serialize()) : null;
    } catch {
        return null;
    }
}
