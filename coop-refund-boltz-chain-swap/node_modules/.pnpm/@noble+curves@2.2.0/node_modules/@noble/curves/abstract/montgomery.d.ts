/**
 * Montgomery curve methods. It's not really whole montgomery curve,
 * just bunch of very specific methods for X25519 / X448 from
 * [RFC 7748](https://www.rfc-editor.org/rfc/rfc7748)
 * @module
 */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
import { type TArg, type TRet } from '../utils.ts';
import { type CurveLengths } from './curve.ts';
/** Curve-specific hooks required to build one X25519/X448 helper. */
export type MontgomeryOpts = {
    /** Prime field modulus. */
    P: bigint;
    /** RFC 7748 variant name. */
    type: 'x25519' | 'x448';
    /**
     * Clamp or otherwise normalize one scalar byte string before use.
     * @param bytes - Raw secret scalar bytes.
     * @returns Adjusted scalar bytes ready for Montgomery multiplication.
     */
    adjustScalarBytes: (bytes: TArg<Uint8Array>) => TRet<Uint8Array>;
    /**
     * Invert one field element with exponentiation by `p - 2`.
     * @param x - Field element to invert.
     * @returns Multiplicative inverse of `x`.
     */
    powPminus2: (x: bigint) => bigint;
    /**
     * Optional randomness source for `keygen()` and `utils.randomSecretKey()`.
     * Receives the requested byte length and returns fresh random bytes.
     */
    randomBytes?: (bytesLength?: number) => TRet<Uint8Array>;
};
/** Public X25519/X448 ECDH API built on a Montgomery ladder. */
export type MontgomeryECDH = {
    /**
     * Multiply one scalar by one Montgomery `u` coordinate.
     * @param scalar - Secret scalar bytes.
     * @param u - Public Montgomery `u` coordinate.
     * @returns Shared point encoded as bytes.
     */
    scalarMult: (scalar: TArg<Uint8Array>, u: TArg<Uint8Array>) => TRet<Uint8Array>;
    /**
     * Multiply one scalar by the curve base point.
     * @param scalar - Secret scalar bytes.
     * @returns Public key bytes.
     */
    scalarMultBase: (scalar: TArg<Uint8Array>) => TRet<Uint8Array>;
    /**
     * Derive a shared secret from a local secret key and peer public key.
     * @param secretKeyA - Local secret key bytes.
     * @param publicKeyB - Peer public key bytes.
     * Rejects low-order public inputs instead of returning the all-zero shared secret.
     * @returns Shared secret bytes.
     */
    getSharedSecret: (secretKeyA: TArg<Uint8Array>, publicKeyB: TArg<Uint8Array>) => TRet<Uint8Array>;
    /**
     * Derive one public key from a secret key.
     * @param secretKey - Secret key bytes.
     * @returns Public key bytes.
     */
    getPublicKey: (secretKey: TArg<Uint8Array>) => TRet<Uint8Array>;
    /** Utility helpers for secret-key generation. */
    utils: {
        /** Generate one random secret key with the curve's expected byte length. */
        randomSecretKey: () => TRet<Uint8Array>;
    };
    /** Encoded Montgomery base point `u`. */
    GuBytes: TRet<Uint8Array>;
    /** Public lengths for keys and seeds. */
    lengths: CurveLengths;
    /**
     * Generate one random secret/public keypair.
     * @param seed - Optional seed bytes to use instead of random generation.
     * @returns Fresh secret/public keypair.
     */
    keygen: (seed?: TArg<Uint8Array>) => {
        secretKey: TRet<Uint8Array>;
        publicKey: TRet<Uint8Array>;
    };
};
/**
 * @param curveDef - Montgomery curve definition.
 * @returns ECDH helper namespace.
 * @throws If the curve definition or derived shared point is invalid. {@link Error}
 * @example
 * Perform one X25519 key exchange through the generic Montgomery helper.
 *
 * ```ts
 * import { x25519 } from '@noble/curves/ed25519.js';
 * const alice = x25519.keygen();
 * const shared = x25519.getSharedSecret(alice.secretKey, alice.publicKey);
 * ```
 */
export declare function montgomery(curveDef: TArg<MontgomeryOpts>): TRet<MontgomeryECDH>;
//# sourceMappingURL=montgomery.d.ts.map