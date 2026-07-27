/**
 * The payment-hold covenant program: authorize-and-capture ("gas pump")
 * payments on Arkade.
 *
 * Lifecycle: the customer funds the contract address (the VTXO value IS the
 * hold), then exactly one of:
 *   - `capture(amount)`    merchant settles a witness-chosen amount; the
 *                          remainder returns to the customer as change
 *   - `captureAll()`       merchant settles the full hold (also used when the
 *                          change would be sub-dust)
 *   - `void()`             merchant cancels; the full hold returns to the customer
 *   - `reclaim()`          after `releaseHeight` the customer unilaterally
 *                          recovers the hold (CLTV) — the anti-hostage path
 *   - `exit`               merchant CSV leaf for L1 unilateral exit (not
 *                          exercised by the demo UI)
 *
 * Reference semantics: examples/payment_hold/payment_hold.ark in
 * arkade-os/compiler#66. Simplifications here: no processor-fee routing, and
 * the sub-dust-change policy is expressed as the separate `captureAll` leaf
 * instead of in-script branching.
 *
 * Security argument: arkd enforces value conservation on ark transactions, so
 * `capture` only needs to pin out0 (merchant, == captureAmount), out1
 * (customer) and out0 + out1 == input value — a third value-bearing output is
 * then arithmetically impossible. No output-count check needed (the builder
 * appends a zero-value extension OP_RETURN and the P2A anchor after the user
 * outputs).
 *
 * `$orderSalt DROP` in the capture leaf is semantically inert; it makes the
 * covenant bytes — and therefore the tweaked co-signer key and the contract
 * address — unique per hold, so concurrent holds between the same parties do
 * not collide on one address.
 */
/** Minimum viable Taproot output value in sats. */
export const DUST = 330n;

/**
 * Local aliases for the SDK's program types. The published package's rolled-up
 * d.ts exports these under `arkade.*` as value declarations (a tsup dts
 * artifact), so they cannot be referenced as types from here.
 */
export type AsmTokens = (string | number | bigint | Uint8Array)[];
export type ParamValues = Record<string, Uint8Array | bigint | number>;

export const paymentHoldProgram = {
    version: 0,
    name: "payment-hold",
    params: [
        { name: "merchantPubkey", type: "pubkey" },
        { name: "customerPubkey", type: "pubkey" },
        { name: "merchantPayout", type: "bytes" },
        { name: "customerPayout", type: "bytes" },
        { name: "orderSalt", type: "bytes" },
        { name: "releaseHeight", type: "int" },
        { name: "exitBlocks", type: "int" },
        { name: "server", type: "pubkey" },
    ] as const,
    functions: {
        capture: {
            inputs: [{ name: "captureAmount", type: "int" }] as const,
            tapscript: { signers: ["$merchantPubkey", "$server"] },
            arkadeScript: {
                asm: [
                    "$orderSalt",
                    "DROP",
                    // out0.value == captureAmount (witness)
                    0,
                    "INSPECTOUTPUTVALUE",
                    "EQUALVERIFY",
                    // out0 is v1 taproot to the merchant payout
                    0,
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$merchantPayout",
                    "EQUALVERIFY",
                    // out1 is v1 taproot to the customer payout
                    1,
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$customerPayout",
                    "EQUALVERIFY",
                    // out0 + out1 == this input's value (change is exact)
                    0,
                    "INSPECTOUTPUTVALUE",
                    1,
                    "INSPECTOUTPUTVALUE",
                    "ADD",
                    "PUSHCURRENTINPUTINDEX",
                    "INSPECTINPUTVALUE",
                    "EQUAL",
                ],
                witness: ["captureAmount"],
            },
        },
        captureAll: {
            tapscript: { signers: ["$merchantPubkey", "$server"] },
            arkadeScript: {
                asm: [
                    // out0 == full input value, to the merchant payout
                    "PUSHCURRENTINPUTINDEX",
                    "INSPECTINPUTVALUE",
                    0,
                    "INSPECTOUTPUTVALUE",
                    "EQUALVERIFY",
                    0,
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$merchantPayout",
                    "EQUAL",
                ],
            },
        },
        void: {
            tapscript: { signers: ["$merchantPubkey", "$server"] },
            arkadeScript: {
                asm: [
                    // out0 == full input value, to the customer payout
                    "PUSHCURRENTINPUTINDEX",
                    "INSPECTINPUTVALUE",
                    0,
                    "INSPECTOUTPUTVALUE",
                    "EQUALVERIFY",
                    0,
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$customerPayout",
                    "EQUAL",
                ],
            },
        },
        reclaim: {
            tapscript: {
                signers: ["$customerPubkey", "$server"],
                cltv: "$releaseHeight",
            },
            arkadeScript: {
                asm: [
                    // same payout covenant as void: everything back to the customer
                    "PUSHCURRENTINPUTINDEX",
                    "INSPECTINPUTVALUE",
                    0,
                    "INSPECTOUTPUTVALUE",
                    "EQUALVERIFY",
                    0,
                    "INSPECTOUTPUTSCRIPTPUBKEY",
                    1,
                    "EQUALVERIFY",
                    "$customerPayout",
                    "EQUAL",
                ],
            },
        },
        exit: {
            tapscript: {
                signers: ["$merchantPubkey"],
                csv: { type: "blocks" as const, value: "$exitBlocks" },
            },
        },
    },
    // The `ark.contract(program, args)` generic validates this literal against
    // the SDK's Program type at every call site (a direct `satisfies` is not
    // possible against the published d.ts — see the alias note above).
};

export type PaymentHoldProgram = typeof paymentHoldProgram;
