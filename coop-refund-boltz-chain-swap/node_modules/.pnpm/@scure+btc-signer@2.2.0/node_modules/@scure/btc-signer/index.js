import { compareBytes, concatBytes, isBytes, pubSchnorr, randomPrivateKeyBytes, taprootTweakPubkey, } from "./utils.js";
// should multisig be exported as classicMultisig?
// prettier-ignore
export { multisig, p2ms, p2pk, p2pkh, p2sh, p2tr, p2tr_ms, p2tr_ns, p2tr_pk, p2wpkh, p2wsh } from "./payment.js";
export { CompactSize, MAX_SCRIPT_BYTE_LENGTH, OP, RawTx, RawWitness, Script, ScriptNum, } from "./script.js";
export { getInputType, Transaction } from "./transaction.js";
export { NETWORK, TAPROOT_UNSPENDABLE_KEY, TEST_NETWORK } from "./utils.js";
export { selectUTXO } from "./utxo.js";
/**
 * Small collection of commonly used utility exports.
 * @example
 * Reach for the grouped helpers when you want the common byte and Taproot utilities.
 * ```ts
 * utils.compareBytes(new Uint8Array([1]), new Uint8Array([2]));
 * ```
 */
// Convenience subset; import from `./utils.ts` when you need the full helper surface.
export const utils = /* @__PURE__ */ (() => Object.freeze({
    isBytes,
    concatBytes,
    compareBytes,
    pubSchnorr,
    randomPrivateKeyBytes,
    taprootTweakPubkey,
}))();
export { _sortPubkeys, Address, combinations, getAddress, OutScript, sortedMultisig, taprootListToTree, WIF, } from "./payment.js";
// remove
export { _DebugPSBT, TaprootControlBlock } from "./psbt.js";
// remove
export { bip32Path, Decimal, DEFAULT_SEQUENCE, PSBTCombine, SigHash } from "./transaction.js";
export { _cmpBig, _Estimator } from "./utxo.js";
//# sourceMappingURL=index.js.map