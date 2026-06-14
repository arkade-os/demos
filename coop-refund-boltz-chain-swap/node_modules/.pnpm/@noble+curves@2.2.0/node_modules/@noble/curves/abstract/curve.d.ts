/**
 * Methods for elliptic curve multiplication by scalars.
 * Contains wNAF, pippenger.
 * @module
 */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
import { type Signer, type TArg, type TRet } from '../utils.ts';
import { type IField } from './modular.ts';
/** Affine point coordinates without projective fields. */
export type AffinePoint<T> = {
    /** Affine x coordinate. */
    x: T;
    /** Affine y coordinate. */
    y: T;
} & {
    Z?: never;
};
/** Base interface for all elliptic-curve point instances. */
export interface CurvePoint<F, P extends CurvePoint<F, P>> {
    /** Affine x coordinate. Different from projective / extended X coordinate. */
    x: F;
    /** Affine y coordinate. Different from projective / extended Y coordinate. */
    y: F;
    /** Projective Z coordinate when the point keeps projective state. */
    Z?: F;
    /**
     * Double the point.
     * @returns Doubled point.
     */
    double(): P;
    /**
     * Negate the point.
     * @returns Negated point.
     */
    negate(): P;
    /**
     * Add another point from the same curve.
     * @param other - Point to add.
     * @returns Sum point.
     */
    add(other: P): P;
    /**
     * Subtract another point from the same curve.
     * @param other - Point to subtract.
     * @returns Difference point.
     */
    subtract(other: P): P;
    /**
     * Compare two points for equality.
     * @param other - Point to compare.
     * @returns Whether the points are equal.
     */
    equals(other: P): boolean;
    /**
     * Multiply the point by a scalar in constant time.
     * Implementations keep the subgroup-scalar contract strict and may reject
     * `0` instead of returning the identity point.
     * @param scalar - Scalar multiplier.
     * @returns Product point.
     */
    multiply(scalar: bigint): P;
    /** Assert that the point satisfies the curve equation and subgroup checks. */
    assertValidity(): void;
    /**
     * Map the point into the prime-order subgroup when the curve requires it.
     * @returns Prime-order point.
     */
    clearCofactor(): P;
    /**
     * Check whether the point is the point at infinity.
     * @returns Whether the point is zero.
     */
    is0(): boolean;
    /**
     * Check whether the point belongs to the prime-order subgroup.
     * @returns Whether the point is torsion-free.
     */
    isTorsionFree(): boolean;
    /**
     * Check whether the point lies in a small torsion subgroup.
     * @returns Whether the point has small order.
     */
    isSmallOrder(): boolean;
    /**
     * Multiply the point by a scalar without constant-time guarantees.
     * Public-scalar callers that need `0` should use this method instead of
     * relying on `multiply(...)` to return the identity point.
     * @param scalar - Scalar multiplier.
     * @returns Product point.
     */
    multiplyUnsafe(scalar: bigint): P;
    /**
     * Massively speeds up `p.multiply(n)` by using precompute tables (caching). See {@link wNAF}.
     * Cache state lives in internal WeakMaps keyed by point identity, not on the point object.
     * Repeating `precompute(...)` for the same point identity replaces the remembered window size
     * and forces table regeneration for that point.
     * @param windowSize - Precompute window size.
     * @param isLazy - calculate cache now. Default (true) ensures it's deferred to first `multiply()`
     * @returns Same point instance with precompute tables attached.
     */
    precompute(windowSize?: number, isLazy?: boolean): P;
    /**
     * Converts point to 2D xy affine coordinates.
     * @param invertedZ - Optional inverted Z coordinate for batch normalization.
     * @returns Affine x/y coordinates.
     */
    toAffine(invertedZ?: F): AffinePoint<F>;
    /**
     * Encode the point into the curve's canonical byte form.
     * @returns Encoded point bytes.
     */
    toBytes(): Uint8Array;
    /**
     * Encode the point into the curve's canonical hex form.
     * @returns Encoded point hex.
     */
    toHex(): string;
}
/** Base interface for elliptic-curve point constructors. */
export interface CurvePointCons<P extends CurvePoint<any, P>> {
    /**
     * Runtime brand check for points created by this constructor.
     * @param item - Value to test.
     * @returns Whether the value is a point from this constructor.
     */
    [Symbol.hasInstance]: (item: unknown) => boolean;
    /** Canonical subgroup generator. */
    BASE: P;
    /** Point at infinity. */
    ZERO: P;
    /** Field for basic curve math */
    Fp: IField<P_F<P>>;
    /** Scalar field, for scalars in multiply and others */
    Fn: IField<bigint>;
    /**
     * Create one point from affine coordinates.
     * Does NOT validate curve, subgroup, or wrapper invariants.
     * Use `.assertValidity()` on adversarial inputs.
     * @param p - Affine point coordinates.
     * @returns Point instance.
     */
    fromAffine(p: AffinePoint<P_F<P>>): P;
    /**
     * Decode a point from the canonical byte encoding.
     * @param bytes - Encoded point bytes.
     * Implementations MUST treat `bytes` as read-only.
     * @returns Point instance.
     */
    fromBytes(bytes: Uint8Array): P;
    /**
     * Decode a point from the canonical hex encoding.
     * @param hex - Encoded point hex.
     * @returns Point instance.
     */
    fromHex(hex: string): P;
}
/** Returns the affine field type for a point instance (`P_F<P> == P.F`). */
export type P_F<P extends CurvePoint<any, P>> = P extends CurvePoint<infer F, P> ? F : never;
/** Returns the affine field type for a point constructor (`PC_F<PC> == PC.P.F`). */
export type PC_F<PC extends CurvePointCons<CurvePoint<any, any>>> = PC['Fp']['ZERO'];
/** Returns the point instance type for a point constructor (`PC_P<PC> == PC.P`). */
export type PC_P<PC extends CurvePointCons<CurvePoint<any, any>>> = PC['ZERO'];
/** Wide point-constructor type used when the concrete curve is not important. */
export type PC_ANY = CurvePointCons<CurvePoint<any, CurvePoint<any, CurvePoint<any, CurvePoint<any, CurvePoint<any, CurvePoint<any, CurvePoint<any, CurvePoint<any, CurvePoint<any, CurvePoint<any, any>>>>>>>>>>>;
/**
 * Validates the static surface of a point constructor.
 * This is only a cheap sanity check for the constructor hooks and fields consumed by generic
 * factories; it does not certify `BASE`/`ZERO` semantics or prove the curve implementation itself.
 * @param Point - Runtime point constructor.
 * @throws On missing constructor hooks or malformed field metadata. {@link TypeError}
 * @example
 * Check that one point constructor exposes the static hooks generic helpers need.
 *
 * ```ts
 * import { ed25519 } from '@noble/curves/ed25519.js';
 * import { validatePointCons } from '@noble/curves/abstract/curve.js';
 * validatePointCons(ed25519.Point);
 * ```
 */
export declare function validatePointCons<P extends CurvePoint<any, P>>(Point: CurvePointCons<P>): void;
/** Byte lengths used by one curve implementation. */
export interface CurveLengths {
    /** Secret-key length in bytes. */
    secretKey?: number;
    /** Compressed public-key length in bytes. */
    publicKey?: number;
    /** Uncompressed public-key length in bytes. */
    publicKeyUncompressed?: number;
    /** Whether public-key encodings include a format prefix byte. */
    publicKeyHasPrefix?: boolean;
    /** Signature length in bytes. */
    signature?: number;
    /** Seed length in bytes when the curve exposes deterministic keygen from seed. */
    seed?: number;
}
/** Reorders or otherwise remaps a batch while preserving its element type. */
export type Mapper<T> = (i: T[]) => T[];
/**
 * Computes both candidates first, but the final selection still branches on `condition`, so this
 * is not a strict constant-time CMOV primitive.
 * @param condition - Whether to negate the point.
 * @param item - Point-like value.
 * @returns Original or negated value.
 * @example
 * Keep the point or return its negation based on one boolean branch.
 *
 * ```ts
 * import { negateCt } from '@noble/curves/abstract/curve.js';
 * import { p256 } from '@noble/curves/nist.js';
 * const maybeNegated = negateCt(true, p256.Point.BASE);
 * ```
 */
export declare function negateCt<T extends {
    negate: () => T;
}>(condition: boolean, item: T): T;
/**
 * Takes a bunch of Projective Points but executes only one
 * inversion on all of them. Inversion is very slow operation,
 * so this improves performance massively.
 * Optimization: converts a list of projective points to a list of identical points with Z=1.
 * Input points are left unchanged; the normalized points are returned as fresh instances.
 * @param c - Point constructor.
 * @param points - Projective points.
 * @returns Fresh projective points reconstructed from normalized affine coordinates.
 * @example
 * Batch-normalize projective points with a single shared inversion.
 *
 * ```ts
 * import { normalizeZ } from '@noble/curves/abstract/curve.js';
 * import { p256 } from '@noble/curves/nist.js';
 * const points = normalizeZ(p256.Point, [p256.Point.BASE, p256.Point.BASE.double()]);
 * ```
 */
export declare function normalizeZ<P extends CurvePoint<any, P>, PC extends CurvePointCons<P>>(c: PC, points: P[]): P[];
/**
 * Elliptic curve multiplication of Point by scalar. Fragile.
 * Table generation takes **30MB of ram and 10ms on high-end CPU**,
 * but may take much longer on slow devices. Actual generation will happen on
 * first call of `multiply()`. By default, `BASE` point is precomputed.
 *
 * Scalars should always be less than curve order: this should be checked inside of a curve itself.
 * Creates precomputation tables for fast multiplication:
 * - private scalar is split by fixed size windows of W bits
 * - every window point is collected from window's table & added to accumulator
 * - since windows are different, same point inside tables won't be accessed more than once per calc
 * - each multiplication is 'Math.ceil(CURVE_ORDER / 𝑊) + 1' point additions (fixed for any scalar)
 * - +1 window is neccessary for wNAF
 * - wNAF reduces table size: 2x less memory + 2x faster generation, but 10% slower multiplication
 *
 * TODO: research returning a 2d JS array of windows instead of a single window.
 * This would allow windows to be in different memory locations.
 * @param Point - Point constructor.
 * @param bits - Scalar bit length.
 * @example
 * Elliptic curve multiplication of Point by scalar.
 *
 * ```ts
 * import { wNAF } from '@noble/curves/abstract/curve.js';
 * import { p256 } from '@noble/curves/nist.js';
 * const ladder = new wNAF(p256.Point, p256.Point.Fn.BITS);
 * ```
 */
export declare class wNAF<PC extends PC_ANY> {
    private readonly BASE;
    private readonly ZERO;
    private readonly Fn;
    readonly bits: number;
    constructor(Point: PC, bits: number);
    _unsafeLadder(elm: PC_P<PC>, n: bigint, p?: PC_P<PC>): PC_P<PC>;
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param point - Point instance
     * @param W - window size
     * @returns precomputed point tables flattened to a single array
     */
    private precomputeWindow;
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * More compact implementation:
     * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
     * @returns real and fake (for const-time) points
     */
    private wNAF;
    /**
     * Implements unsafe EC multiplication using precomputed tables
     * and w-ary non-adjacent form.
     * @param acc - accumulator point to add result of multiplication
     * @returns point
     */
    private wNAFUnsafe;
    private getPrecomputes;
    cached(point: PC_P<PC>, scalar: bigint, transform?: Mapper<PC_P<PC>>): {
        p: PC_P<PC>;
        f: PC_P<PC>;
    };
    unsafe(point: PC_P<PC>, scalar: bigint, transform?: Mapper<PC_P<PC>>, prev?: PC_P<PC>): PC_P<PC>;
    createCache(P: PC_P<PC>, W: number): void;
    hasCache(elm: PC_P<PC>): boolean;
}
/**
 * Endomorphism-specific multiplication for Koblitz curves.
 * Cost: 128 dbl, 0-256 adds.
 * @param Point - Point constructor.
 * @param point - Input point.
 * @param k1 - First non-negative absolute scalar chunk.
 * @param k2 - Second non-negative absolute scalar chunk.
 * @returns Partial multiplication results.
 * @example
 * Endomorphism-specific multiplication for Koblitz curves.
 *
 * ```ts
 * import { mulEndoUnsafe } from '@noble/curves/abstract/curve.js';
 * import { secp256k1 } from '@noble/curves/secp256k1.js';
 * const parts = mulEndoUnsafe(secp256k1.Point, secp256k1.Point.BASE, 3n, 5n);
 * ```
 */
export declare function mulEndoUnsafe<P extends CurvePoint<any, P>, PC extends CurvePointCons<P>>(Point: PC, point: P, k1: bigint, k2: bigint): {
    p1: P;
    p2: P;
};
/**
 * Pippenger algorithm for multi-scalar multiplication (MSM, Pa + Qb + Rc + ...).
 * 30x faster vs naive addition on L=4096, 10x faster than precomputes.
 * For N=254bit, L=1, it does: 1024 ADD + 254 DBL. For L=5: 1536 ADD + 254 DBL.
 * Algorithmically constant-time (for same L), even when 1 point + scalar, or when scalar = 0.
 * @param c - Curve Point constructor
 * @param points - array of L curve points
 * @param scalars - array of L scalars (aka secret keys / bigints)
 * @returns MSM result point. Empty input is accepted and returns the identity.
 * @throws If the point set, scalar set, or MSM sizing is invalid. {@link Error}
 * @example
 * Pippenger algorithm for multi-scalar multiplication (MSM, Pa + Qb + Rc + ...).
 *
 * ```ts
 * import { pippenger } from '@noble/curves/abstract/curve.js';
 * import { p256 } from '@noble/curves/nist.js';
 * const point = pippenger(p256.Point, [p256.Point.BASE, p256.Point.BASE.double()], [2n, 3n]);
 * ```
 */
export declare function pippenger<P extends CurvePoint<any, P>, PC extends CurvePointCons<P>>(c: PC, points: P[], scalars: bigint[]): P;
/**
 * Precomputed multi-scalar multiplication (MSM, Pa + Qb + Rc + ...).
 * @param c - Curve Point constructor
 * @param points - array of L curve points
 * @param windowSize - Precompute window size.
 * @returns Function which multiplies points with scalars. The closure accepts
 *   `scalars.length <= points.length`, and omitted trailing scalars are treated as zero.
 * @throws If the point set or precompute window is invalid. {@link Error}
 * @example
 * Precomputed multi-scalar multiplication (MSM, Pa + Qb + Rc + ...).
 *
 * ```ts
 * import { precomputeMSMUnsafe } from '@noble/curves/abstract/curve.js';
 * import { p256 } from '@noble/curves/nist.js';
 * const msm = precomputeMSMUnsafe(p256.Point, [p256.Point.BASE], 4);
 * const point = msm([3n]);
 * ```
 */
export declare function precomputeMSMUnsafe<P extends CurvePoint<any, P>, PC extends CurvePointCons<P>>(c: PC, points: P[], windowSize: number): (scalars: bigint[]) => P;
/** Minimal curve parameters needed to construct a Weierstrass or Edwards curve. */
export type ValidCurveParams<T> = {
    /** Base-field modulus. */
    p: bigint;
    /** Prime subgroup order. */
    n: bigint;
    /** Cofactor. */
    h: bigint;
    /** Curve parameter `a`. */
    a: T;
    /** Weierstrass curve parameter `b`. */
    b?: T;
    /** Edwards curve parameter `d`. */
    d?: T;
    /** Generator x coordinate. */
    Gx: T;
    /** Generator y coordinate. */
    Gy: T;
};
/** Pair of fields used by curve constructors. */
export type FpFn<T> = {
    /** Base field used for curve coordinates. */
    Fp: IField<T>;
    /** Scalar field used for secret scalars and subgroup arithmetic. */
    Fn: IField<bigint>;
};
/**
 * Validates basic CURVE shape and field membership, then creates fields.
 * This does not prove that the generator is on-curve, that subgroup/order data are consistent, or
 * that the curve equation itself is otherwise sane.
 * @param type - Curve family.
 * @param CURVE - Curve parameters.
 * @param curveOpts - Optional field overrides:
 *   - `Fp` (optional): Optional base-field override.
 *   - `Fn` (optional): Optional scalar-field override.
 * @param FpFnLE - Whether field encoding is little-endian.
 * @returns Frozen curve parameters and fields.
 * @throws If the curve parameters or field overrides are invalid. {@link Error}
 * @example
 * Build curve fields from raw constants before constructing a curve instance.
 *
 * ```ts
 * const curve = createCurveFields('weierstrass', {
 *   p: 17n,
 *   n: 19n,
 *   h: 1n,
 *   a: 2n,
 *   b: 2n,
 *   Gx: 5n,
 *   Gy: 1n,
 * });
 * ```
 */
export declare function createCurveFields<T>(type: 'weierstrass' | 'edwards', CURVE: ValidCurveParams<T>, curveOpts?: TArg<Partial<FpFn<T>>>, FpFnLE?: boolean): TRet<FpFn<T> & {
    CURVE: ValidCurveParams<T>;
}>;
type KeygenFn = (seed?: Uint8Array, isCompressed?: boolean) => {
    secretKey: Uint8Array;
    publicKey: Uint8Array;
};
/**
 * @param randomSecretKey - Secret-key generator.
 * @param getPublicKey - Public-key derivation helper.
 * @returns Keypair generator.
 * @example
 * Build a `keygen()` helper from existing secret-key and public-key primitives.
 *
 * ```ts
 * import { createKeygen } from '@noble/curves/abstract/curve.js';
 * import { p256 } from '@noble/curves/nist.js';
 * const keygen = createKeygen(p256.utils.randomSecretKey, p256.getPublicKey);
 * const pair = keygen();
 * ```
 */
export declare function createKeygen(randomSecretKey: Function, getPublicKey: TArg<Signer['getPublicKey']>): TRet<KeygenFn>;
export {};
//# sourceMappingURL=curve.d.ts.map