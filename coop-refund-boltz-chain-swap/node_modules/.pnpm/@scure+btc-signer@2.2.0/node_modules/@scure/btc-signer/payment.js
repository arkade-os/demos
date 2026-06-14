import { bech32, bech32m, createBase58check, hex } from '@scure/base';
import { anumber } from '@noble/hashes/utils.js';
import { abytes } from '@noble/curves/utils.js';
import * as P from 'micro-packed';
import { TaprootControlBlock } from "./psbt.js";
import { MAX_SCRIPT_BYTE_LENGTH, OpToNum, Script, VarBytes } from "./script.js";
import * as u from "./utils.js";
import { NETWORK } from "./utils.js";
const OutP2A = {
    encode(from) {
        // BIP433 defines P2A as the exact OP_1 <0x4e73> scriptPubKey.
        if (from.length !== 2 || from[0] !== 1 || !u.isBytes(from[1]) || hex.encode(from[1]) !== '4e73')
            return;
        return { type: 'p2a', script: Script.encode(from) };
    },
    decode: (to) => {
        if (to.type !== 'p2a')
            return;
        // The decoded object keeps `script` for caller convenience, but the `p2a`
        // tag always canonicalizes back to the fixed BIP433 script.
        return [1, hex.decode('4e73')];
    },
};
function isValidPubkey(pub, type) {
    // Payment coders use a boolean guard here and normalize validatePubkey failures to false.
    try {
        u.validatePubkey(pub, type);
        return true;
    }
    catch (e) {
        return false;
    }
}
const OutPK = {
    encode(from) {
        // BIP380/BIP381 `pk(KEY)` only admits SEC1 ECDSA pubkeys here; x-only
        // 32-byte CHECKSIG scripts are left for the later tapscript coders.
        if (from.length !== 2 ||
            !u.isBytes(from[0]) ||
            !isValidPubkey(from[0], u.PubT.ecdsa) ||
            from[1] !== 'CHECKSIG')
            return;
        return { type: 'pk', pubkey: from[0] };
    },
    decode: (to) => {
        if (to.type !== 'pk')
            return;
        // OutScript validates `pk.pubkey` before this branch emits the canonical
        // `<pubkey> CHECKSIG` script.
        return [to.pubkey, 'CHECKSIG'];
    },
};
const OutPKH = {
    encode(from) {
        if (from.length !== 5 || from[0] !== 'DUP' || from[1] !== 'HASH160' || !u.isBytes(from[2]))
            return;
        // OutScript validates that the pushed HASH160 is exactly 20 bytes.
        // This child matcher only recognizes the canonical P2PKH opcode skeleton.
        if (from[3] !== 'EQUALVERIFY' || from[4] !== 'CHECKSIG')
            return;
        return { type: 'pkh', hash: from[2] };
    },
    // OutScript validates `pkh.hash` before this branch emits the canonical
    // `DUP HASH160 <hash> EQUALVERIFY CHECKSIG` script.
    decode: (to) => (to.type === 'pkh'
        ? ['DUP', 'HASH160', to.hash, 'EQUALVERIFY', 'CHECKSIG']
        : undefined),
};
const OutSH = {
    encode(from) {
        if (from.length !== 3 || from[0] !== 'HASH160' || !u.isBytes(from[1]) || from[2] !== 'EQUAL')
            return;
        // OutScript validates that the pushed HASH160 is exactly 20 bytes.
        // This child matcher only recognizes the canonical P2SH opcode skeleton.
        return { type: 'sh', hash: from[1] };
    },
    // OutScript validates `sh.hash` before this branch emits the canonical
    // `HASH160 <hash> EQUAL` script.
    decode: (to) => (to.type === 'sh' ? ['HASH160', to.hash, 'EQUAL'] : undefined),
};
const OutWSH = {
    encode(from) {
        if (from.length !== 2 || from[0] !== 0 || !u.isBytes(from[1]))
            return;
        // BIP382 `wsh()` is specifically the version-0 32-byte witness program.
        // Other witness versions stay with the later coders.
        if (from[1].length !== 32)
            return;
        return { type: 'wsh', hash: from[1] };
    },
    // OutScript validates `wsh.hash` before this branch emits the canonical
    // version-0 32-byte witness program.
    decode: (to) => (to.type === 'wsh' ? [0, to.hash] : undefined),
};
const OutWPKH = {
    encode(from) {
        if (from.length !== 2 || from[0] !== 0 || !u.isBytes(from[1]))
            return;
        // BIP382 `wpkh()` is specifically the version-0 20-byte witness program.
        // Compressed-key restrictions are enforced upstream, and other witness
        // versions stay with the later coders.
        if (from[1].length !== 20)
            return;
        return { type: 'wpkh', hash: from[1] };
    },
    // OutScript validates `wpkh.hash` before this branch emits the canonical
    // version-0 20-byte witness program.
    decode: (to) => (to.type === 'wpkh' ? [0, to.hash] : undefined),
};
const OutMS = {
    encode(from) {
        const last = from.length - 1;
        if (from[last] !== 'CHECKMULTISIG')
            return;
        const m = from[0];
        const n = from[last - 1];
        if (typeof m !== 'number' || typeof n !== 'number')
            return;
        const pubkeys = from.slice(1, -2);
        if (n !== pubkeys.length)
            return;
        for (const pub of pubkeys)
            if (!u.isBytes(pub))
                return;
        // OutScript validates pubkey encodings and `0 < m <= n <= 16`.
        // This child matcher only recognizes the canonical CHECKMULTISIG skeleton.
        // We don't need n here because it is the same as pubkeys.length.
        return { type: 'ms', m, pubkeys: pubkeys };
    },
    // checkmultisig(n, ..pubkeys, m)
    decode: (to) => 
    // OutScript validates multisig pubkeys and `0 < m <= n <= 16`.
    // This branch only emits the canonical `m <pubkeys...> n CHECKMULTISIG`
    // script.
    (to.type === 'ms'
        ? [to.m, ...to.pubkeys, to.pubkeys.length, 'CHECKMULTISIG']
        : undefined),
};
const OutTR = {
    encode(from) {
        // BIP141 witness programs are `OP_0..OP_16` followed by a direct 2..40-byte push.
        // BIP341 assigns native taproot meaning only to version 1 with a 32-byte x-only program;
        // other OP_1 program lengths remain reserved future witness programs and should fall through.
        if (from.length !== 2 || from[0] !== 1 || !u.isBytes(from[1]) || from[1].length !== 32)
            return;
        return { type: 'tr', pubkey: from[1] };
    },
    // OutScript validates `tr.pubkey` before this branch emits the canonical
    // version-1 32-byte witness program.
    decode: (to) => (to.type === 'tr' ? [1, to.pubkey] : undefined),
};
const OutTRNS = {
    encode(from) {
        const last = from.length - 1;
        if (from[last] !== 'CHECKSIG')
            return;
        const pubkeys = [];
        // On error return, since it can be different script
        for (let i = 0; i < last; i++) {
            const elm = from[i];
            if (i & 1) {
                if (elm !== 'CHECKSIGVERIFY' || i === last - 1)
                    return;
                continue;
            }
            // Require actual Schnorr pubkeys here so near-miss `<bytes> CHECKSIG`
            // scripts fall through to OutUnknown instead of failing later.
            if (!u.isBytes(elm) || !isValidPubkey(elm, u.PubT.schnorr))
                return;
            pubkeys.push(elm);
        }
        // BIP342 "Using a k-of-k script for every combination" documents the shape
        // `<pubkey_1> CHECKSIGVERIFY ... <pubkey_n> CHECKSIG`; this matcher only
        // classifies that embedded-pubkey form, so bare CHECKSIG stays unknown.
        if (!pubkeys.length)
            return;
        return { type: 'tr_ns', pubkeys };
    },
    decode: (to) => {
        if (to.type !== 'tr_ns')
            return;
        const out = [];
        for (let i = 0; i < to.pubkeys.length - 1; i++)
            out.push(to.pubkeys[i], 'CHECKSIGVERIFY');
        // This branch assumes at least one Schnorr pubkey; [] would otherwise emit
        // `[undefined, CHECKSIG]` and only fail later in Script.encode.
        out.push(to.pubkeys[to.pubkeys.length - 1], 'CHECKSIG');
        return out;
    },
};
const OutTRMS = {
    encode(from) {
        const last = from.length - 1;
        if (from[last] !== 'NUMEQUAL' || from[1] !== 'CHECKSIG')
            return;
        const pubkeys = [];
        const m = OpToNum(from[last - 1]);
        if (typeof m !== 'number')
            return;
        for (let i = 0; i < last - 1; i++) {
            const elm = from[i];
            // Structural mismatches should fall through to OutUnknown instead of
            // throwing from the tr_ms matcher.
            if (i & 1) {
                if (elm !== (i === 1 ? 'CHECKSIG' : 'CHECKSIGADD'))
                    return;
                continue;
            }
            if (!u.isBytes(elm))
                return;
            pubkeys.push(elm);
        }
        return { type: 'tr_ms', pubkeys, m };
    },
    decode: (to) => {
        if (to.type !== 'tr_ms')
            return;
        const out = [to.pubkeys[0], 'CHECKSIG'];
        for (let i = 1; i < to.pubkeys.length; i++)
            out.push(to.pubkeys[i], 'CHECKSIGADD');
        // This branch assumes `m` was already validated as an integer ScriptNum;
        // fractional JS numbers would otherwise serialize as a different threshold.
        out.push(to.m, 'NUMEQUAL');
        return out;
    },
};
const OutUnknown = {
    encode(from) {
        // This is the catch-all fallback for scripts no structured coder recognized,
        // so earlier matchers must return `undefined` instead of throwing on mismatch.
        // Because this reserializes the parsed Script AST, unknown scripts preserve
        // semantics but not original non-minimal push spellings.
        return { type: 'unknown', script: Script.encode(from) };
    },
    decode: (to) => 
    // This reparses `unknown.script` through the semantic Script codec, so raw
    // bytes must still be syntactically parseable and may canonicalize on re-encode.
    (to.type === 'unknown' ? Script.decode(to.script) : undefined),
};
// /Payments
const OutScripts = /* @__PURE__ */ (() => [
    // Order is semantic: specific structured coders run first and the catch-all
    // unknown fallback must stay last.
    OutP2A,
    OutPK,
    OutPKH,
    OutSH,
    OutWSH,
    OutWPKH,
    OutMS,
    OutTR,
    OutTRNS,
    OutTRMS,
    OutUnknown,
])();
// TODO: we can support user supplied output scripts now
// - addOutScript
// - removeOutScript
// - We can do that as log we modify array in-place
// - Actually is very hard, since there is sign/finalize logic
// Raw composition of semantic Script parsing with the ordered output-script
// matcher; OutScript adds the higher-level validation layer on top.
const _OutScript = /* @__PURE__ */ (() => P.apply(Script, P.coders.match(OutScripts)))();
// We can validate this once, because of packed & coders
/**
 * Coder for recognized Bitcoin output scripts.
 * @example
 * Decode a serialized output script back into the tagged payment descriptor.
 * ```ts
 * import { OutScript, p2wpkh } from '@scure/btc-signer/payment.js';
 * import { pubECDSA, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
 * const pay = p2wpkh(pubECDSA(randomPrivateKeyBytes()));
 * OutScript.decode(pay.script);
 * ```
 */
export const OutScript = /* @__PURE__ */ (() => Object.freeze(P.validate(_OutScript, (i) => {
    if (i.type === 'pk' && !isValidPubkey(i.pubkey, u.PubT.ecdsa))
        throw new Error('OutScript/pk: wrong key');
    if ((i.type === 'pkh' || i.type === 'sh' || i.type === 'wpkh') &&
        (!u.isBytes(i.hash) || i.hash.length !== 20))
        throw new Error(`OutScript/${i.type}: wrong hash`);
    if (i.type === 'wsh' && (!u.isBytes(i.hash) || i.hash.length !== 32))
        throw new Error(`OutScript/wsh: wrong hash`);
    if (i.type === 'tr' && (!u.isBytes(i.pubkey) || !isValidPubkey(i.pubkey, u.PubT.schnorr)))
        throw new Error('OutScript/tr: wrong taproot public key');
    if (i.type === 'ms' || i.type === 'tr_ns' || i.type === 'tr_ms')
        if (!Array.isArray(i.pubkeys))
            throw new Error('OutScript/multisig: wrong pubkeys array');
    if (i.type === 'ms') {
        const n = i.pubkeys.length;
        for (const p of i.pubkeys)
            if (!isValidPubkey(p, u.PubT.ecdsa))
                throw new Error('OutScript/multisig: wrong pubkey');
        // Range checks are not enough here: non-integer JS numbers like 1.5 would
        // otherwise slip through and serialize as a different ScriptNum threshold.
        anumber(i.m, 'm');
        if (i.m <= 0 || n > 16 || i.m > n)
            throw new Error('OutScript/multisig: invalid params');
    }
    if (i.type === 'tr_ns' || i.type === 'tr_ms') {
        for (const p of i.pubkeys)
            if (!isValidPubkey(p, u.PubT.schnorr))
                throw new Error(`OutScript/${i.type}: wrong pubkey`);
    }
    if (i.type === 'tr_ms') {
        const n = i.pubkeys.length;
        // BIP 342 keeps the 1000-element stack limit. This CHECKSIG/CHECKSIGADD form
        // momentarily has n witness items plus one pushed pubkey on the stack, so n must stay <= 999.
        anumber(i.m, 'm');
        if (i.m <= 0 || n > 999 || i.m > n)
            throw new Error('OutScript/tr_ms: invalid params');
    }
    return i;
})))();
// Basic sanity check for scripts
function checkWSH(s, witnessScript) {
    if (!u.equalBytes(s.hash, u.sha256(witnessScript)))
        throw new Error('checkScript: wsh wrong witnessScript hash');
    // BIP141 only requires the witnessScript hash match; the type-based rejects
    // below are an extra descriptor sanity layer for BIP382 invalid-descriptor
    // bullets `wpkh() nested in wsh()` and `wsh() nested in wsh()`.
    const w = OutScript.decode(witnessScript);
    if (w.type === 'tr' || w.type === 'tr_ns' || w.type === 'tr_ms')
        throw new Error(`checkScript: P2${w.type} cannot be wrapped in P2SH`);
    if (w.type === 'wpkh' || w.type === 'wsh' || w.type === 'sh')
        throw new Error(`checkScript: P2${w.type} cannot be wrapped in P2WSH`);
}
/**
 * Validates that nested redeem and witness scripts match their wrappers.
 * @param script - top-level output script
 * @param redeemScript - optional redeem script for P2SH wrappers
 * @param witnessScript - optional witness script for P2WSH wrappers
 * @throws If the script nesting is invalid or unsupported. {@link Error}
 * @example
 * Verify that wrapped scripts and hashes still match after custom edits.
 * ```ts
 * import { hex } from '@scure/base';
 * import { checkScript, p2pkh, p2sh } from '@scure/btc-signer/payment.js';
 * const wrapped = p2sh(
 *   p2pkh(hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'))
 * );
 * checkScript(wrapped.script, wrapped.redeemScript);
 * ```
 */
export function checkScript(script, redeemScript, witnessScript) {
    let hasWsh = false;
    let r = undefined;
    if (script) {
        const s = OutScript.decode(script);
        // BIP174 Data Signers Check For bullets: provided redeemScript must match
        // the scriptPubKey, and provided witnessScript must match the scriptPubKey
        // or redeemScript instead of being silently ignored as stray metadata.
        // ms||pk maybe work, but there will be no address, hard to spend
        if (s.type === 'tr_ns' || s.type === 'tr_ms' || s.type === 'ms' || s.type == 'pk')
            throw new Error(`checkScript: non-wrapped ${s.type}`);
        if (redeemScript) {
            if (s.type !== 'sh')
                throw new Error('checkScript: redeemScript without P2SH');
            if (!u.equalBytes(s.hash, u.hash160(redeemScript)))
                throw new Error('checkScript: sh wrong redeemScript hash');
            r = OutScript.decode(redeemScript);
            if (r?.type === 'tr' || r?.type === 'tr_ns' || r?.type === 'tr_ms')
                throw new Error(`checkScript: P2${r.type} cannot be wrapped in P2SH`);
            // Not sure if this unspendable, but we cannot represent this via PSBT
            if (r?.type === 'sh')
                throw new Error('checkScript: P2SH cannot be wrapped in P2SH');
        }
        if (s.type === 'wsh') {
            hasWsh = true;
            if (witnessScript)
                checkWSH(s, witnessScript);
        }
    }
    if (redeemScript) {
        if (r === undefined)
            r = OutScript.decode(redeemScript);
        if (r?.type === 'wsh') {
            hasWsh = true;
            if (witnessScript)
                checkWSH(r, witnessScript);
        }
    }
    if (witnessScript && !hasWsh)
        throw new Error('checkScript: witnessScript without P2WSH');
}
function uniqPubkey(pubkeys) {
    const map = {};
    for (const pub of pubkeys) {
        // Exact-byte duplicate filter only: BIP383 valid vectors still permit the
        // same point to appear in compressed and uncompressed SEC1 form in multi().
        const key = hex.encode(pub);
        if (map[key])
            throw new Error(`Multisig: non-uniq pubkey: ${pubkeys.map(hex.encode)}`);
        map[key] = true;
    }
}
/**
 * Builds a pay-to-public-key script.
 * @param pubkey - compressed or uncompressed ECDSA public key
 * @param _network - unused network placeholder for API consistency
 * @returns P2PK descriptor.
 * @throws If the public key cannot be encoded as a P2PK output. {@link Error}
 * @example
 * Build a bare pay-to-public-key output.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2pk } from '@scure/btc-signer/payment.js';
 * p2pk(hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'));
 * ```
 */
export const p2pk = (pubkey, _network = NETWORK) => {
    // network is unused
    if (!isValidPubkey(pubkey, u.PubT.ecdsa))
        throw new Error('P2PK: invalid publicKey');
    return {
        type: 'pk',
        script: OutScript.encode({ type: 'pk', pubkey }),
    };
};
/**
 * Builds a P2PKH output from a public key.
 * @param publicKey - compressed or uncompressed ECDSA public key bytes; HASH160 commits to the exact encoding
 * @param network - address network parameters
 * @returns P2PKH descriptor.
 * @throws If the public key cannot be encoded as a P2PKH output. {@link Error}
 * @example
 * Build a classic pay-to-public-key-hash output.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2pkh } from '@scure/btc-signer/payment.js';
 * p2pkh(hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'));
 * ```
 */
export const p2pkh = (publicKey, network = NETWORK) => {
    if (!isValidPubkey(publicKey, u.PubT.ecdsa))
        throw new Error('P2PKH: invalid publicKey');
    const hash = u.hash160(publicKey);
    return {
        type: 'pkh',
        script: OutScript.encode({ type: 'pkh', hash }),
        address: Address(network).encode({ type: 'pkh', hash }),
        hash,
    };
};
/**
 * Wraps a child script inside P2SH.
 * @param child - child payment descriptor to wrap
 * @param network - address network parameters
 * @returns P2SH descriptor preserving witness metadata when present.
 * @throws If the wrapped script combination is invalid or unsupported. {@link Error}
 * @example
 * Wrap a child script in P2SH so it gets a base58 address form.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2pk, p2sh, p2wsh } from '@scure/btc-signer/payment.js';
 * p2sh(p2wsh(p2pk(hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'))));
 * ```
 */
export const p2sh = (child, network = NETWORK) => {
    // It is already tested inside noble-hashes and checkScript
    // BIP16 redeemScripts are pushed by scriptSig, so anything over the 520-byte pushed-element
    // limit would be fundable by HASH160 but unspendable once wrapped in P2SH.
    const c = child;
    const cs = c.script;
    if (!u.isBytes(cs))
        throw new Error(`Wrong script: ${typeof c.script}, expected Uint8Array`);
    if (cs.length > MAX_SCRIPT_BYTE_LENGTH)
        throw new Error(`P2SH: redeemScript exceeds ${MAX_SCRIPT_BYTE_LENGTH}-byte push limit: len=${cs.length}`);
    const hash = u.hash160(cs);
    const out = { type: 'sh', hash };
    const script = OutScript.encode(out);
    const address = Address(network).encode(out);
    checkScript(script, cs, c.witnessScript);
    if (c.witnessScript) {
        return {
            type: 'sh',
            redeemScript: cs,
            script,
            address,
            hash,
            witnessScript: c.witnessScript,
        };
    }
    else {
        return {
            type: 'sh',
            redeemScript: cs,
            script,
            address,
            hash,
        };
    }
};
/**
 * Wraps a child script inside native SegWit P2WSH.
 * @param child - child payment descriptor to wrap
 * @param network - address network parameters
 * @returns P2WSH descriptor.
 * @throws If the wrapped script combination is invalid or unsupported. {@link Error}
 * @example
 * Wrap a child script in native SegWit P2WSH.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2pk, p2wsh } from '@scure/btc-signer/payment.js';
 * p2wsh(p2pk(hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')));
 * ```
 */
export const p2wsh = (child, network = NETWORK) => {
    const cs = child.script;
    if (!u.isBytes(cs))
        throw new Error(`Wrong script: ${typeof cs}, expected Uint8Array`);
    // BIP141 P2WSH says the witness "must consist of ... a serialized script (witnessScript)"
    // and that witnessScript is limited to 10,000 bytes, so larger wrapped scripts must reject.
    if (cs.length > 10000)
        throw new Error('P2WSH: witnessScript exceeds 10,000 bytes');
    const hash = u.sha256(cs);
    const script = OutScript.encode({ type: 'wsh', hash });
    checkScript(script, undefined, cs);
    return {
        type: 'wsh',
        witnessScript: cs,
        script,
        address: Address(network).encode({ type: 'wsh', hash }),
        hash,
    };
};
/**
 * Builds a native SegWit P2WPKH output from a public key.
 * @param publicKey - compressed ECDSA public key
 * @param network - address network parameters
 * @returns P2WPKH descriptor.
 * @throws If the public key cannot be encoded as a P2WPKH output. {@link Error}
 * @example
 * Build a native SegWit pay-to-public-key-hash output.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2wpkh } from '@scure/btc-signer/payment.js';
 * p2wpkh(hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'));
 * ```
 */
export const p2wpkh = (publicKey, network = NETWORK) => {
    if (!isValidPubkey(publicKey, u.PubT.ecdsa))
        throw new Error('P2WPKH: invalid publicKey');
    // BIP 143 default policy: version-0 witness programs MUST use 33-byte compressed ECDSA keys.
    if (publicKey.length === 65)
        throw new Error('P2WPKH: uncompressed public key');
    const hash = u.hash160(publicKey);
    return {
        type: 'wpkh',
        script: OutScript.encode({ type: 'wpkh', hash }),
        address: Address(network).encode({ type: 'wpkh', hash }),
        hash,
    };
};
/**
 * Builds a bare multisig script.
 * @param m - number of required signatures
 * @param pubkeys - participating public keys
 * @param allowSamePubkeys - whether duplicate keys are allowed
 * @returns P2MS descriptor.
 * @throws If the multisig parameters are invalid. {@link Error}
 * @example
 * Build a bare multisig output script.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2ms } from '@scure/btc-signer/payment.js';
 * p2ms(1, [hex.decode('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')], true);
 * ```
 */
export const p2ms = (m, pubkeys, allowSamePubkeys = false) => {
    // BIP 11 only standardized bare multisig up to 3 keys; this helper still permits up to 16
    // because the same script shape is commonly wrapped by p2sh()/p2wsh() instead of used bare.
    if (!allowSamePubkeys)
        uniqPubkey(pubkeys);
    return {
        type: 'ms',
        script: OutScript.encode({ type: 'ms', pubkeys, m }),
    };
};
function checkTaprootScript(script, internalPubKey, allowUnknownOutputs = false, customScripts) {
    const out = OutScript.decode(script);
    if (out.type === 'unknown') {
        // NOTE: this check should be before allowUnknownOutputs, otherwise it will
        // disable custom. All custom scripts for taproot should have prefix 'tr_'
        if (customScripts) {
            const cs = P.apply(Script, P.coders.match(customScripts));
            const c = cs.decode(script);
            if (c !== undefined) {
                if (typeof c.type !== 'string' || !c.type.startsWith('tr_'))
                    throw new Error(`P2TR: invalid custom type=${c.type}`);
                return;
            }
        }
        if (allowUnknownOutputs)
            return;
    }
    if (!['tr_ns', 'tr_ms'].includes(out.type))
        throw new Error(`P2TR: invalid leaf script=${out.type}`);
    const outms = out;
    if (!allowUnknownOutputs && outms.pubkeys) {
        for (const p of outms.pubkeys) {
            if (u.equalBytes(p, u.TAPROOT_UNSPENDABLE_KEY))
                throw new Error('Unspendable taproot key in leaf script');
            // It's likely a mistake at this point:
            // 1. p2tr(A, p2tr_ns(2, [A, B])) == p2tr(A, p2tr_pk(B)) (A or B key)
            // but will take more space and fees.
            // 2. For multi-sig p2tr(A, p2tr_ns(2, [A, B, C])) it's probably a security issue:
            // User creates 2 of 3 multisig of keys [A, B, C],
            // but key A always can spend whole output without signatures from other keys.
            // p2tr(A, p2tr_ns(2, [B, C, D])) is ok: A or (B and C) or (B and D) or (C and D)
            if (u.equalBytes(p, internalPubKey)) {
                throw new Error('Using P2TR with leaf script with same key as internal key is not supported');
            }
        }
    }
}
// Helper for generating binary tree from list, with weights
/**
 * Converts a flat list of weighted leaves into a binary taproot tree.
 * @param taprootList - weighted leaves to arrange
 * @returns Binary taproot script tree.
 * @throws If the list is empty and cannot describe any tree. {@link Error}
 * @example
 * Start from a flat weighted list, then let the helper build the binary tree shape.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2tr_pk, taprootListToTree } from '@scure/btc-signer/payment.js';
 * taprootListToTree([
 *   p2tr_pk(hex.decode('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9')),
 *   p2tr_pk(hex.decode('dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659')),
 * ]);
 * ```
 */
export function taprootListToTree(taprootList) {
    // Empty flat lists cannot represent a taproot script tree; omit the tree entirely for
    // key-path-only outputs instead of passing [] here, otherwise this helper would return
    // undefined and downstream taproot tree walkers would fail much later on a non-tree value.
    if (!taprootList.length)
        throw new Error('taprootListToTree: empty tree');
    // Clone input in order to not corrupt it
    const lst = Array.from(taprootList);
    // We have at least 2 elements => can create branch
    while (lst.length >= 2) {
        // Sort: elements with smallest weight are in the end of queue
        lst.sort((a, b) => (b.weight || 1) - (a.weight || 1));
        const b = lst.pop();
        const a = lst.pop();
        const weight = (a?.weight || 1) + (b?.weight || 1);
        lst.push({
            weight,
            // Unwrap children array
            // TODO: Very hard to remove any here
            childs: [a?.childs || a, b?.childs || b],
        });
    }
    // At this point there is always 1 element in lst
    const last = lst[0];
    return (last?.childs || last);
}
function taprootAddPath(tree, path = []) {
    if (!tree)
        throw new Error(`taprootAddPath: empty tree`);
    if (tree.type === 'leaf')
        return { ...tree, path };
    if (tree.type !== 'branch')
        throw new Error(`taprootAddPath: wrong type=${tree}`);
    return {
        ...tree,
        path,
        // BIP 341 control blocks serialize sibling hashes from leaf to root, so prepend the
        // current sibling before descending into the child subtree.
        left: taprootAddPath(tree.left, [tree.right.hash, ...path]),
        right: taprootAddPath(tree.right, [tree.left.hash, ...path]),
    };
}
function taprootWalkTree(tree) {
    if (!tree)
        throw new Error(`taprootAddPath: empty tree`);
    if (tree.type === 'leaf')
        return [tree];
    if (tree.type !== 'branch')
        throw new Error(`taprootWalkTree: wrong type=${tree}`);
    // Keep a stable left-to-right DFS leaf order when flattening the annotated tree.
    return [...taprootWalkTree(tree.left), ...taprootWalkTree(tree.right)];
}
function taprootHashTree(tree, internalPubKey, allowUnknownOutputs = false, customScripts) {
    if (!tree)
        throw new Error('taprootHashTree: empty tree');
    if (Array.isArray(tree) && tree.length === 1)
        tree = tree[0];
    // Terminal node (leaf)
    if (!Array.isArray(tree)) {
        const version = tree.leafVersion;
        const { script: leafScript } = tree;
        // Earliest tree walk where we can validate tapScripts
        if (tree.tapLeafScript || (tree.tapMerkleRoot && !u.equalBytes(tree.tapMerkleRoot, P.EMPTY)))
            throw new Error('P2TR: tapRoot leafScript cannot have tree');
        const script = typeof leafScript === 'string' ? hex.decode(leafScript) : leafScript;
        if (!u.isBytes(script))
            throw new Error(`checkScript: wrong script type=${script}`);
        checkTaprootScript(script, internalPubKey, allowUnknownOutputs, customScripts);
        return {
            type: 'leaf',
            version,
            script,
            hash: tapLeafHash(script, tapLeafVersion(version)),
        };
    }
    // If tree / branch is not binary tree, convert it
    if (tree.length !== 2)
        tree = taprootListToTree(tree);
    if (tree.length !== 2)
        throw new Error('hashTree: non binary tree!');
    // branch
    // Both nodes should exist
    const left = taprootHashTree(tree[0], internalPubKey, allowUnknownOutputs, customScripts);
    const right = taprootHashTree(tree[1], internalPubKey, allowUnknownOutputs, customScripts);
    // BIP 341 sorts TapBranch child hashes lexicographically for hashing, but the original
    // left/right structure still determines the control-block sibling paths for each leaf.
    let [lH, rH] = [left.hash, right.hash];
    if (u.compareBytes(rH, lH) === -1)
        [lH, rH] = [rH, lH];
    return {
        type: 'branch',
        left,
        right,
        hash: u.tagSchnorr('TapBranch', lH, rH),
    };
}
/** Default tapleaf version used by taproot script-path outputs before adding the parity bit. */
export const TAP_LEAF_VERSION = 0xc0;
const tapLeafVersion = (version) => {
    if (version === undefined)
        return TAP_LEAF_VERSION;
    anumber(version, 'leafVersion');
    // BIP341 script-path validation defines the effective leaf version as `v = c[0] & 0xfe`
    // and says it cannot be odd or `0x50`; tapleaf hashes also serialize this as one byte.
    if (version > 0xfe || version === 0x50 || !!(version & 1))
        throw new Error(`P2TR: invalid leafVersion=${version}`);
    return version;
};
/**
 * Computes the tagged hash of a tapleaf script.
 * @param script - tapleaf script bytes
 * @param version - base even tapleaf version byte (for tapscript, `0xc0`)
 * @returns Tapleaf hash.
 * @throws If the tapleaf version is not a valid even one-byte version.
 * {@link Error}
 * @example
 * Hash a finalized tapscript leaf before placing it into a Merkle tree.
 * ```ts
 * tapLeafHash(new Uint8Array([0x51]));
 * ```
 */
export const tapLeafHash = (script, version = TAP_LEAF_VERSION) => u.tagSchnorr('TapLeaf', new Uint8Array([tapLeafVersion(version)]), VarBytes.encode(script));
export function p2tr(internalPubKey, tree, network = NETWORK, allowUnknownOutputs = false, customScripts) {
    // Unspendable
    if (!internalPubKey && !tree)
        throw new Error('p2tr: should have pubKey or scriptTree (or both)');
    const pubKey = typeof internalPubKey === 'string'
        ? hex.decode(internalPubKey)
        : internalPubKey || u.TAPROOT_UNSPENDABLE_KEY;
    if (!isValidPubkey(pubKey, u.PubT.schnorr))
        throw new Error('p2tr: non-schnorr pubkey');
    if (tree) {
        let hashedTree = taprootAddPath(taprootHashTree(tree, pubKey, allowUnknownOutputs, customScripts));
        const tapMerkleRoot = hashedTree.hash;
        const [tweakedPubkey, parity] = u.taprootTweakPubkey(pubKey, tapMerkleRoot);
        const leaves = taprootWalkTree(hashedTree).map((l) => {
            const version = tapLeafVersion(l.version);
            return {
                ...l,
                // Leaf versions are stored as the base even byte; only the control block adds the
                // output-key parity bit required by BIP 341 script-path spending.
                controlBlock: TaprootControlBlock.encode({
                    version: version + parity,
                    internalKey: pubKey,
                    merklePath: l.path,
                }),
            };
        });
        return {
            type: 'tr',
            script: OutScript.encode({ type: 'tr', pubkey: tweakedPubkey }),
            address: Address(network).encode({ type: 'tr', pubkey: tweakedPubkey }),
            // For tests
            tweakedPubkey,
            // PSBT stuff
            tapInternalKey: pubKey,
            leaves,
            tapLeafScript: leaves.map((l) => [
                TaprootControlBlock.decode(l.controlBlock),
                u.concatBytes(l.script, new Uint8Array([tapLeafVersion(l.version)])),
            ]),
            tapMerkleRoot,
        };
    }
    else {
        // BIP 341 / BIP 86: key-only Taproot still tweaks with the empty Merkle root so the
        // output commits to an unspendable script path instead of leaving the key untweaked.
        const tweakedPubkey = u.taprootTweakPubkey(pubKey, P.EMPTY)[0];
        return {
            type: 'tr',
            script: OutScript.encode({ type: 'tr', pubkey: tweakedPubkey }),
            address: Address(network).encode({ type: 'tr', pubkey: tweakedPubkey }),
            // For tests
            tweakedPubkey,
            // PSBT stuff
            tapInternalKey: pubKey,
        };
    }
}
// Returns all combinations of size M from lst
/**
 * Returns all size-`m` combinations from a list.
 * @param m - size of each combination
 * @param list - input items to combine
 * @returns Array of combinations.
 * @throws If the combination size or input list is invalid. {@link Error}
 * @example
 * Enumerate all size-two subsets of a short list.
 * ```ts
 * combinations(2, [1, 2, 3]);
 * ```
 */
export function combinations(m, list) {
    const res = [];
    if (!Array.isArray(list))
        throw new Error('combinations: lst arg should be array');
    const n = list.length;
    anumber(m, 'm');
    if (m < 1 || m > n)
        throw new Error('combinations: m must satisfy 1 <= m <= lst.length');
    /*
    Basically works as M nested loops like:
    for (;idx[0]<lst.length;idx[0]++) for (idx[1]=idx[0]+1;idx[1]<lst.length;idx[1]++)
    but since we cannot create nested loops dynamically, we unroll it to a single loop
    */
    // This unrolled-loop implementation assumes an integer 1 <= m <= n; zero, negative, and
    // fractional m values need an explicit guard before entering the loop.
    const idx = Array.from({ length: m }, (_, i) => i);
    const last = idx.length - 1;
    main: for (;;) {
        res.push(idx.map((i) => list[i]));
        idx[last] += 1;
        let i = last;
        // Propagate increment
        // idx[i] cannot be bigger than n-m+i, otherwise last elements in right part will overflow
        for (; i >= 0 && idx[i] > n - m + i; i--) {
            idx[i] = 0;
            // Overflow in idx[0], break
            if (i === 0)
                break main;
            idx[i - 1] += 1;
        }
        // Propagate: idx[i+1] = idx[idx]+1
        for (i += 1; i < idx.length; i++)
            idx[i] = idx[i - 1] + 1;
    }
    return res;
}
/**
 * Builds the leaf set for an M-of-N `CHECKSIGVERIFY` taproot policy.
 * @param m - number of required signatures
 * @param pubkeys - participating Schnorr public keys
 * @param allowSamePubkeys - whether duplicate keys are allowed
 * @returns Array of taproot leaf descriptors.
 * @throws If the taproot multisig parameters are invalid. {@link Error}
 * @example
 * Build the leaf set for an M-of-N taproot `CHECKSIGVERIFY` policy.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2tr_ns } from '@scure/btc-signer/payment.js';
 * p2tr_ns(1, [hex.decode('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9')], true);
 * ```
 */
export const p2tr_ns = (m, pubkeys, allowSamePubkeys = false) => {
    if (!allowSamePubkeys)
        uniqPubkey(pubkeys);
    return combinations(m, pubkeys).map((i) => ({
        type: 'tr_ns',
        script: OutScript.encode({ type: 'tr_ns', pubkeys: i }),
    }));
};
/**
 * Builds a single-key taproot leaf script.
 * BIP 341 design guidance: if this is the most likely single-key spend path, prefer
 * using that key as the `p2tr()` internal key instead of forcing it into a script leaf.
 * @param pubkey - Schnorr public key
 * @returns Taproot single-key leaf descriptor.
 * @throws If the taproot single-key leaf cannot be encoded. {@link Error}
 * @example
 * Build a single-key tapscript leaf.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2tr_pk } from '@scure/btc-signer/payment.js';
 * p2tr_pk(hex.decode('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'));
 * ```
 */
export const p2tr_pk = (pubkey) => p2tr_ns(1, [pubkey], undefined)[0];
/**
 * Builds a `CHECKSIGADD` taproot multisig leaf.
 * @param m - number of required signatures
 * @param pubkeys - participating Schnorr public keys
 * @param allowSamePubkeys - whether duplicate keys are allowed
 * @returns Taproot multisig leaf descriptor.
 * @throws If the taproot multisig parameters are invalid. {@link Error}
 * @example
 * Build a `CHECKSIGADD` taproot multisig leaf.
 * ```ts
 * import { hex } from '@scure/base';
 * import { p2tr_ms } from '@scure/btc-signer/payment.js';
 * p2tr_ms(1, [hex.decode('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9')], true);
 * ```
 */
export function p2tr_ms(m, pubkeys, allowSamePubkeys = false) {
    if (!allowSamePubkeys)
        uniqPubkey(pubkeys);
    return {
        type: 'tr_ms',
        script: OutScript.encode({ type: 'tr_ms', pubkeys, m }),
    };
}
// Simple pubkey address, without complex scripts
/**
 * Derives a simple address from a private key.
 * @param type - address type to derive
 * @param privKey - private key bytes
 * @param network - address network parameters
 * @returns Encoded Bitcoin address.
 * @throws If the requested address type is unknown. {@link Error}
 * @example
 * Pick the output type first, then derive the matching address from the private key.
 * ```ts
 * import { getAddress } from '@scure/btc-signer/payment.js';
 * import { randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
 * getAddress('wpkh', randomPrivateKeyBytes());
 * ```
 */
export function getAddress(type, privKey, network = NETWORK) {
    if (type === 'tr') {
        return p2tr(u.pubSchnorr(privKey), undefined, network).address;
    }
    // This convenience wrapper always uses the compressed ECDSA public key; derive
    // `pubECDSA(privKey, false)` and call `p2pkh(...)` directly for legacy uncompressed P2PKH.
    const pubKey = u.pubECDSA(privKey);
    if (type === 'pkh')
        return p2pkh(pubKey, network).address;
    if (type === 'wpkh')
        return p2wpkh(pubKey, network).address;
    throw new Error(`getAddress: unknown type=${type}`);
}
// BIP67 defines canonical multisig ordering only for compressed pubkeys; this helper still sorts
// raw bytes generically, and higher-level callers may accept uncompressed participants for compat.
export const _sortPubkeys = (pubkeys) => Array.from(pubkeys).sort(u.compareBytes);
/**
 * Builds a classic M-of-N multisig output, wrapped in P2SH or P2WSH.
 * @param m - number of required signatures
 * @param pubkeys - participating public keys
 * @param sorted - whether to sort the public keys first
 * @param witness - whether to wrap the result as native SegWit
 * @param network - address network parameters
 * @returns Multisig payment descriptor.
 * @throws If the multisig parameters or wrapped script are invalid. {@link Error}
 * @example
 * Wrap a classic 2-of-2 script into an addressable multisig output.
 * ```ts
 * import { multisig } from '@scure/btc-signer/payment.js';
 * import { pubECDSA, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
 * multisig(
 *   2,
 *   [pubECDSA(randomPrivateKeyBytes()), pubECDSA(randomPrivateKeyBytes())],
 *   true,
 *   true
 * );
 * ```
 */
export function multisig(m, pubkeys, sorted = false, witness = false, network = NETWORK) {
    // BIP 143 default policy: version-0 witness programs should use compressed ECDSA pubkeys only;
    // witness multisig callers must avoid uncompressed keys because p2ms accepts generic ECDSA encodings.
    // BIP 16 caps spendable compressed-key P2SH multisig at 15 pubkeys because larger redeem scripts
    // exceed the 520-byte push limit; use witness=true for larger classic multisig sets.
    const ms = p2ms(m, sorted ? _sortPubkeys(pubkeys) : pubkeys);
    return (witness ? p2wsh(ms, network) : p2sh(ms, network));
}
/**
 * Builds a multisig output after lexicographically sorting the keys.
 * @param m - number of required signatures
 * @param pubkeys - participating public keys
 * @param witness - whether to wrap the result as native SegWit
 * @param network - address network parameters
 * @returns Sorted multisig payment descriptor.
 * @throws If the multisig parameters or wrapped script are invalid. {@link Error}
 * @example
 * Sort public keys deterministically before constructing the multisig address.
 * ```ts
 * import { sortedMultisig } from '@scure/btc-signer/payment.js';
 * import { pubECDSA, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
 * sortedMultisig(
 *   2,
 *   [pubECDSA(randomPrivateKeyBytes()), pubECDSA(randomPrivateKeyBytes())],
 *   true
 * );
 * ```
 */
export function sortedMultisig(m, pubkeys, witness = false, network = NETWORK) {
    // BIP67 canonical multisig is compressed-only, but this wrapper intentionally keeps the generic
    // sorted-multisig behavior and still allows uncompressed participant keys for compatibility.
    return multisig(m, pubkeys, true, witness, network);
}
const base58check = /* @__PURE__ */ createBase58check(u.sha256);
function validateWitness(version, data) {
    if (data.length < 2 || data.length > 40)
        throw new Error('Witness: invalid length');
    if (version > 16)
        throw new Error('Witness: invalid version');
    if (version === 0 && !(data.length === 20 || data.length === 32))
        throw new Error('Witness: invalid length for version');
}
function programToWitness(version, data, network = NETWORK) {
    validateWitness(version, data);
    // BIP 350 keeps segwit v0 on Bech32, while witness versions 1+ switch to Bech32m.
    const coder = version === 0 ? bech32 : bech32m;
    return coder.encode(network.bech32, [version].concat(coder.toWords(data)));
}
function formatKey(hashed, prefix) {
    // Legacy Base58Check paths all serialize [version-byte || payload] before checksumming.
    return base58check.encode(u.concatBytes(Uint8Array.from(prefix), hashed));
}
/**
 * Wallet-import-format coder for private keys.
 * @param network - address network parameters
 * @returns WIF coder.
 * @example
 * Encode or decode wallet-import-format private keys.
 * ```ts
 * const coder = WIF();
 * coder.encode(new Uint8Array(32).fill(1));
 * ```
 */
export function WIF(network = NETWORK) {
    return {
        encode(privKey) {
            // Compressed WIF is exactly 32 private-key bytes plus the 0x01 suffix; shorter or longer
            // inputs must be rejected instead of being silently padded or truncated by subarray().
            abytes(privKey, 32, 'privKey');
            const compressed = u.concatBytes(privKey, new Uint8Array([0x01]));
            return formatKey(compressed.subarray(0, 33), [network.wif]);
        },
        decode(wif) {
            let parsed = base58check.decode(wif);
            if (parsed[0] !== network.wif)
                throw new Error('Wrong WIF prefix');
            parsed = parsed.subarray(1);
            // Check what it is. Compressed flag?
            if (parsed.length !== 33)
                throw new Error('Wrong WIF length');
            if (parsed[32] !== 0x01)
                throw new Error('Wrong WIF postfix');
            return parsed.subarray(0, -1);
        },
    };
}
// Returns OutType, which can be used to create outscript
/**
 * Address encoder/decoder for a specific Bitcoin network.
 * @param network - address network parameters
 * @returns Address coder backed by the provided network.
 * @example
 * Create a network-specific address coder and encode a payment descriptor.
 * ```ts
 * import { Address, p2wpkh } from '@scure/btc-signer/payment.js';
 * import { pubECDSA, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
 * const coder = Address();
 * coder.encode(p2wpkh(pubECDSA(randomPrivateKeyBytes())));
 * ```
 */
export function Address(network = NETWORK) {
    return {
        encode(from) {
            const { type } = from;
            if (type === 'wpkh')
                return programToWitness(0, from.hash, network);
            else if (type === 'wsh')
                return programToWitness(0, from.hash, network);
            else if (type === 'tr')
                return programToWitness(1, from.pubkey, network);
            else if (type === 'pkh')
                return formatKey(from.hash, [network.pubKeyHash]);
            else if (type === 'sh')
                return formatKey(from.hash, [network.scriptHash]);
            throw new Error(`Unknown address type=${type}`);
        },
        decode(address) {
            if (address.length < 14 || address.length > 74)
                throw new Error('Invalid address length');
            // Bech32
            if (network.bech32 && address.toLowerCase().startsWith(`${network.bech32}1`)) {
                let res;
                try {
                    res = bech32.decode(address);
                    if (res.words[0] !== 0)
                        throw new Error(`bech32: wrong version=${res.words[0]}`);
                }
                catch (_) {
                    // Starting from version 1 it is decoded as bech32m
                    res = bech32m.decode(address);
                    if (res.words[0] === 0)
                        throw new Error(`bech32m: wrong version=${res.words[0]}`);
                }
                if (res.prefix !== network.bech32)
                    throw new Error(`wrong bech32 prefix=${res.prefix}`);
                const [version, ...program] = res.words;
                const data = bech32.fromWords(program);
                validateWitness(version, data);
                if (version === 0 && data.length === 32)
                    return { type: 'wsh', hash: data };
                else if (version === 0 && data.length === 20)
                    return { type: 'wpkh', hash: data };
                else if (version === 1 && data.length === 32)
                    return { type: 'tr', pubkey: data };
                // Future witness versions can still be valid addresses, but this helper
                // only returns typed descriptors for recognized v0 and taproot templates.
                else
                    throw new Error('Unknown witness program');
            }
            const data = base58check.decode(address);
            if (data.length !== 21)
                throw new Error('Invalid base58 address');
            // Pay To Public Key Hash
            if (data[0] === network.pubKeyHash) {
                return { type: 'pkh', hash: data.slice(1) };
            }
            else if (data[0] === network.scriptHash) {
                return {
                    type: 'sh',
                    hash: data.slice(1),
                };
            }
            throw new Error(`Invalid address prefix=${data[0]}`);
        },
    };
}
//# sourceMappingURL=payment.js.map