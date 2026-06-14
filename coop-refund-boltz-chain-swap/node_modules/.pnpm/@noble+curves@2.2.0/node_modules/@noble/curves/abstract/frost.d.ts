import { randomBytes, type TArg, type TRet } from '../utils.ts';
import { type CurvePoint, type CurvePointCons } from './curve.ts';
import { type H2CDSTOpts } from './hash-to-curve.ts';
import { type IField } from './modular.ts';
export type RNG = typeof randomBytes;
export type Identifier = string;
export type Commitment = Uint8Array;
export type Coefficient = Uint8Array;
export type Signature = Uint8Array;
export type Signers = {
    min: number;
    max: number;
};
export type SecretKey = Uint8Array;
export type Bytes = Uint8Array;
type Point = Uint8Array;
export type DKG_Round1 = {
    identifier: Identifier;
    commitment: TRet<Commitment[]>;
    proofOfKnowledge: TRet<Signature>;
};
export type DKG_Round2 = {
    identifier: Identifier;
    signingShare: TRet<Bytes>;
};
export type DKG_Secret = {
    identifier: bigint;
    coefficients?: bigint[];
    commitment: TRet<Point[]>;
    signers: Signers;
    step?: 1 | 2 | 3;
};
export type FrostPublic = {
    signers: Signers;
    commitments: TRet<Bytes[]>;
    verifyingShares: TRet<Record<Identifier, Bytes>>;
};
export type FrostSecret = {
    identifier: Identifier;
    signingShare: TRet<Bytes>;
};
export type Key = {
    public: FrostPublic;
    secret: FrostSecret;
};
export type DealerShares = {
    public: FrostPublic;
    secretShares: Record<Identifier, FrostSecret>;
};
export type Nonces = {
    hiding: TRet<Bytes>;
    binding: TRet<Bytes>;
};
export type NonceCommitments = {
    identifier: Identifier;
    hiding: TRet<Bytes>;
    binding: TRet<Bytes>;
};
export type GenNonce = {
    nonces: Nonces;
    commitments: NonceCommitments;
};
export interface FROSTPoint<T extends CurvePoint<any, T>> extends CurvePoint<any, T> {
    add(rhs: T): T;
    multiply(rhs: bigint): T;
    equals(rhs: T): boolean;
    toBytes(compressed?: boolean): Bytes;
    clearCofactor(): T;
}
export interface FROSTPointConstructor<T extends FROSTPoint<T>> extends CurvePointCons<T> {
    fromBytes(a: Bytes): T;
    Fn: IField<bigint>;
}
export type FrostOpts<P extends FROSTPoint<P>> = {
    readonly name: string;
    readonly Point: FROSTPointConstructor<P>;
    readonly Fn?: IField<bigint>;
    /** Optional suite hook that tightens canonical decoding with subgroup / identity checks. */
    readonly validatePoint?: (p: P) => void;
    /** Optional public-key parser. Implementations MUST preserve the same subgroup / identity policy
     * as `validatePoint`, because this bypasses generic canonical decoding in `parsePoint()`. */
    readonly parsePublicKey?: (bytes: TArg<Uint8Array>) => P;
    readonly hash: (msg: TArg<Uint8Array>) => TRet<Uint8Array>;
    /** Custom scalar hash hook. Implementations MUST treat `msg` and `options` as read-only. */
    readonly hashToScalar?: (msg: TArg<Uint8Array>, options?: TArg<H2CDSTOpts>) => bigint;
    readonly adjustScalar?: (n: bigint) => bigint;
    readonly adjustPoint?: (n: P) => P;
    readonly challenge?: (R: P, PK: P, msg: TArg<Uint8Array>) => bigint;
    readonly adjustNonces?: (PK: P, nonces: TArg<Nonces>) => TRet<Nonces>;
    readonly adjustSecret?: (secret: TArg<FrostSecret>, pub: TArg<FrostPublic>) => TRet<FrostSecret>;
    readonly adjustPublic?: (pub: TArg<FrostPublic>) => TRet<FrostPublic>;
    readonly adjustGroupCommitmentShare?: (GC: P, GCShare: P) => P;
    readonly adjustTx?: {
        readonly encode: (tx: TArg<Uint8Array>) => TRet<Uint8Array>;
        readonly decode: (tx: TArg<Uint8Array>) => TRet<Uint8Array>;
    };
    readonly adjustDKG?: (k: TArg<Key>) => TRet<Key>;
    readonly H1?: string;
    readonly H2?: string;
    readonly H3?: string;
    readonly H4?: string;
    readonly H5?: string;
    readonly HDKG?: string;
    readonly HID?: string;
};
/**
 * FROST: Threshold Protocol for Two‑Round Schnorr Signatures
 * from [RFC 9591](https://datatracker.ietf.org/doc/rfc9591/).
 */
export type FROST = {
    /**
     * Methods to construct participant identifiers.
     */
    Identifier: {
        /**
         * Constructs an identifier from a numeric index.
         * @param n - A positive integer.
         * @returns A canonical serialized Identifier.
         */
        fromNumber(n: number): Identifier;
        /**
         * Derives an identifier deterministically from a string (e.g. an email).
         * @param s - Arbitrary string.
         * @returns A canonical serialized Identifier.
         */
        derive(s: string): Identifier;
    };
    /**
     * Distributed Key Generation (DKG) protocol interface.
     * RFC 9591 leaves DKG out of scope; Appendix C only specifies dealer/VSS key generation.
     * These helpers follow the split-round API used by frost-rs for interoperable testing.
     */
    DKG: {
        /**
         * Generates the first round of DKG.
         * @param id - Participant's identifier.
         * @param signers - Set of all participants (min/max threshold).
         * @param secret - Optional initial secret scalar.
         * @param rng - Optional RNG for nonce generation.
         * @returns Public broadcast and private DKG state. The returned `secret` package is mutable
         *   round state that will be consumed by `round2()` and `round3()`.
         */
        round1: (id: Identifier, signers: Signers, secret?: TArg<SecretKey>, rng?: RNG) => {
            public: DKG_Round1;
            secret: DKG_Secret;
        };
        /**
         * Executes DKG round 2 given public round1 data from others.
         * @param secret - Private DKG state from round1. This mutates `secret.step` in place.
         * @param others - Public round1 broadcasts from other participants.
         * @returns A map of round2 messages to be sent to others.
         */
        round2: (secret: TArg<DKG_Secret>, others: TArg<DKG_Round1[]>) => TRet<Record<string, DKG_Round2>>;
        /**
         * Finalizes key generation in round3 using received round1 + round2 messages.
         * @param secret - Private DKG state. This consumes the remaining local polynomial coefficients
         *   and transitions the package to its final post-round3 state.
         * @param round1 - Public round1 broadcasts from all participants.
         * @param round2 - Round2 messages received from others.
         * @returns Final secret/public key information for the participant.
         * Callers MUST pass the same verified remote `round1` package set that was already
         * accepted in `round2()`, rather than re-fetching or rebuilding it from the network.
         */
        round3: (secret: TArg<DKG_Secret>, round1: TArg<DKG_Round1[]>, round2: TArg<DKG_Round2[]>) => TRet<Key>;
        /**
         * Best-effort erasure of internal secret state. Bigint/JIT copies may still survive outside the
         * local object even after cleanup.
         * @param secret - Private DKG state from round1.
         */
        clean(secret: TArg<DKG_Secret>): void;
    };
    /**
     * Trusted dealer mode: generates key shares from a central trusted authority.
     * Mirrors RFC 9591 Appendix C and returns one shared VSS commitment package
     * plus per-participant shares.
     * @param signers - Threshold parameters (min/max).
     * @param identifiers - Optional explicit participant list.
     * @param secret - Optional secret scalar.
     * @param rng - Optional RNG.
     * @returns One shared public package plus the participant secret-share packages.
     */
    trustedDealer(signers: Signers, identifiers?: Identifier[], secret?: TArg<SecretKey>, rng?: RNG): TRet<DealerShares>;
    /**
     * Validates the consistency of a secret share against the shared public commitments.
     * This is the RFC 9591 Appendix C.2 `vss_verify` check against the shared dealer/DKG commitment.
     * It does not relax RFC 9591 Section 3.1: public identity elements are still invalid even when
     * the scalar/share algebra would otherwise be self-consistent.
     * Throws if invalid.
     * @param secret - A FrostSecret containing identifier and signing share.
     * @param pub - Shared public package containing commitments.
     */
    validateSecret(secret: TArg<FrostSecret>, pub: TArg<FrostPublic>): void;
    /**
     * Produces nonces and public commitments used in signing.
     * RFC 9591 Section 5.1 `commit()`.
     * @param secret - Participant's secret share.
     * @param rng - Optional RNG.
     * @returns Nonce values and their public commitments.
     * Returned nonces are one-time-use and MUST NOT be reused across signing sessions.
     * This API does not mutate or zeroize caller-owned nonce objects.
     */
    commit(secret: TArg<FrostSecret>, rng?: RNG): TRet<GenNonce>;
    /**
     * Signs a message using the participant's secret and nonce.
     * @param secret - Participant's secret share.
     * @param pub - Shared public package containing commitments.
     * @param nonces - Participant's nonce pair.
     * @param commitmentList - Commitments from all signing participants.
     * @param msg - Message to be signed.
     * @returns Signature share as a byte array.
     * RFC 9591 Sections 4.1/5.1 require round-one commitments to be one-time-use, and
     * Section 5.2 signs with the nonce corresponding to that published commitment.
     * The caller MUST pass fresh nonces from `commit()`. On successful signing, this helper
     * consumes the caller-owned nonce object by zeroing both nonce byte arrays in place.
     * Later calls reject an all-zero nonce package, so same-object reuse fails closed and an
     * accidentally generated zero nonce package is not silently used for signing.
     */
    signShare(secret: TArg<FrostSecret>, pub: TArg<FrostPublic>, nonces: TArg<Nonces>, commitmentList: TArg<NonceCommitments[]>, msg: TArg<Uint8Array>): TRet<Uint8Array>;
    /**
     * Verifies a signature share against public commitments.
     * Matches the coordinator-side individual-share verification from RFC 9591 Section 5.4.
     * @param pub - Group public key information.
     * @param commitmentList - Commitments from all signing participants.
     * @param msg - Message being signed.
     * @param identifier - Identifier of the signer whose share is being verified.
     * @param sigShare - Signature share to verify.
     * @returns True if valid, false otherwise.
     */
    verifyShare(pub: TArg<FrostPublic>, commitmentList: TArg<NonceCommitments[]>, msg: TArg<Uint8Array>, identifier: Identifier, sigShare: TArg<Uint8Array>): boolean;
    /**
     * Aggregates signature shares into a full signature.
     * RFC 9591 Section 5.3 `aggregate()`.
     * @param pub - Group public key.
     * @param commitmentList - Nonce commitments from all signers.
     * @param msg - Message to sign.
     * @param sigShares - Map from identifier to their signature share.
     * @returns Final aggregated signature.
     */
    aggregate(pub: TArg<FrostPublic>, commitmentList: TArg<NonceCommitments[]>, msg: TArg<Uint8Array>, sigShares: TArg<Record<Identifier, Uint8Array>>): TRet<Uint8Array>;
    /**
     * Signs a message using a raw secret key (e.g. from combineSecret).
     * @param msg - Message to sign.
     * @param secretKey - Group secret key as bytes.
     * @returns Signature bytes.
     */
    sign(msg: TArg<Uint8Array>, secretKey: TArg<Uint8Array>): TRet<Uint8Array>;
    /**
     * Verifies a full signature against the group public key.
     * @param sig - Signature bytes.
     * @param msg - Message that was signed.
     * @param publicKey - Group public key.
     * @returns True if valid, false otherwise.
     */
    verify(sig: TArg<Signature>, msg: TArg<Uint8Array>, publicKey: TArg<Uint8Array>): boolean;
    /**
     * Combines multiple secret shares into a single secret key (e.g. for recovery).
     * @param shares - Set of FrostSecret shares.
     * @param signers - Threshold parameters.
     * @returns Group secret key as bytes.
     */
    combineSecret(shares: TArg<FrostSecret[]>, signers: Signers): TRet<Uint8Array>;
    /**
     * Low-level helper utilities (field arithmetic and polynomial tools).
     */
    utils: {
        /**
         * Finite field used for scalars.
         */
        Fn: IField<bigint>;
        /**
         * Generates a random scalar (private key).
         * @param rng - Optional RNG source.
         * @returns Scalar as 32-byte Uint8Array.
         */
        randomScalar: (rng?: RNG) => TRet<Uint8Array>;
        /**
         * Generates a secret-sharing polynomial and its public commitments.
         * @param signers - Threshold parameters.
         * @param secret - Optional initial secret scalar.
         * @param coeffs - Optional manual coefficients.
         * @param rng - Optional RNG.
         * @returns Polynomial coefficients, commitments, and secret value.
         */
        generateSecretPolynomial: (signers: Signers, secret?: TArg<Uint8Array>, coeffs?: bigint[], rng?: RNG) => {
            coefficients: bigint[];
            commitment: TRet<Point[]>;
            secret: bigint;
        };
    };
};
export declare function createFROST<P extends FROSTPoint<P>>(opts: FrostOpts<P>): TRet<FROST>;
export {};
//# sourceMappingURL=frost.d.ts.map