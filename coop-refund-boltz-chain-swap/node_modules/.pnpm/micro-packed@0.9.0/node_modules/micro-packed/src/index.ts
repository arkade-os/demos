import { hex as baseHex, utf8, type Coder as BaseCoder } from '@scure/base';
import type { TArg, TRet } from '@scure/base';
export type { TArg, TRet } from '@scure/base';

/**
 * Define complex binary structures using composable primitives.
 * Main ideas:
 * - Encode / decode can be chained, same as in `scure-base`
 * - A complex structure can be created from an array and struct of primitive types
 * - Strings / bytes are arrays with specific optimizations: we can just read bytes directly
 *   without creating plain array first and reading each byte separately.
 * - Types are inferred from definition
 * @module
 * @example
 * Define a struct with numbers, strings, bytes, and nested arrays.
 * ```ts
 * import * as P from 'micro-packed';
 * const s = P.struct({
 *   field1: P.U32BE, // 32-bit unsigned big-endian integer
 *   field2: P.string(P.U8), // String with U8 length prefix
 *   field3: P.bytes(32), // 32 bytes
 *   field4: P.array(P.U16BE, P.struct({ // Array of structs with U16BE length
 *     subField1: P.U64BE, // 64-bit unsigned big-endian integer
 *     subField2: P.string(10) // 10-byte string
 *   }))
 * });
 * ```
 */

// TODO: remove dependency on scure-base & inline?

/*
Exports can be groupped like this:

- Primitive types: P.bytes, P.string, P.hex, P.constant, P.pointer
- Complex types: P.array, P.struct, P.tuple, P.map, P.tag, P.mappedTag
- Padding, prefix, magic: P.padLeft, P.padRight, P.prefix, P.magic, P.magicBytes
- Flags: P.flag, P.flagged, P.optional
- Wrappers: P.apply, P.wrap, P.lazy
- Bit fiddling: P.bits, P.bitset
- utils: P.validate, coders.decimal
- Debugger
*/

/**
 * Shortcut to zero-length (empty) byte array.
 * Keep public Bytes typing, not TRet<Bytes>, so variables inferred from this
 * constant can later accept caller-owned Bytes backed by any ArrayBufferLike.
 */
export const EMPTY: Bytes = /* @__PURE__ */ Uint8Array.of();
/**
 * Shortcut to one-element (element is 0) byte array.
 * Keep the same public Bytes typing rationale as EMPTY.
 */
export const NULL: Bytes = /* @__PURE__ */ Uint8Array.of(0);
/** Prototype-sensitive names cannot roundtrip as normal fields on plain decoded objects. */
const restrictedKeys = /* @__PURE__ */ new Set(['__proto__', 'constructor', 'prototype']);
const validateFieldName = (name: unknown, label: string): void => {
  if (typeof name !== 'string') throw new Error(`${label} should be string, got ${typeof name}`);
  if (name.includes('..')) throw new TypeError(`${label} ${name} cannot contain path parent ..`);
  if (name.includes('/')) throw new TypeError(`${label} ${name} cannot contain path separator /`);
  if (restrictedKeys.has(name)) throw new Error(`${label} ${name} is reserved`);
};

/** Checks if two Uint8Arrays are equal. Not constant-time. */
function equalBytes(a: TArg<Uint8Array>, b: TArg<Uint8Array>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
type BytesFinder = (data: TArg<Uint8Array>, pos?: number) => number | undefined;
function createFindBytes(needle: TArg<Uint8Array>): TRet<BytesFinder> {
  if (needle.length === 1) {
    const byte = needle[0];
    return (data, pos = 0) => {
      const idx = data.indexOf(byte, pos);
      return idx === -1 ? undefined : idx;
    };
  }
  // KMP avoids quadratic scans on repeated-prefix terminators.
  const back = new Uint32Array(needle.length);
  for (let i = 1, j = 0; i < needle.length; i++) {
    while (j && needle[i] !== needle[j]) j = back[j - 1];
    if (needle[i] === needle[j]) back[i] = ++j;
  }
  return (data, pos = 0) => {
    for (let i = pos, j = 0; i < data.length; i++) {
      while (j && data[i] !== needle[j]) j = back[j - 1];
      if (data[i] !== needle[j]) continue;
      if (++j === needle.length) return i - needle.length + 1;
    }
    return undefined;
  };
}
const findBytes = (needle: TArg<Uint8Array>, data: TArg<Uint8Array>, pos = 0): number | undefined =>
  createFindBytes(needle)(data, pos);
/** Compares values used as encoded-domain constants; byte arrays compare by contents. */
function equal(a: unknown, b: unknown): boolean {
  const aBytes = isBytes(a);
  const bBytes = isBytes(b);
  if (aBytes || bBytes) return aBytes && bBytes && equalBytes(a, b);
  return a === b;
}
/** Checks if the given value is a Uint8Array. */
function isBytes(a: unknown): a is Bytes {
  // Plain `instanceof Uint8Array` is too strict for some Buffer / proxy / cross-realm cases. The
  // fallback still requires a real ArrayBuffer view, so plain JSON-deserialized
  // `{ constructor: ... }` spoofing is rejected. `BYTES_PER_ELEMENT === 1` keeps
  // the fallback on byte-oriented views.
  return (
    a instanceof Uint8Array ||
    (ArrayBuffer.isView(a) &&
      a.constructor.name === 'Uint8Array' &&
      'BYTES_PER_ELEMENT' in a &&
      a.BYTES_PER_ELEMENT === 1)
  );
}

/**
 * Concatenates multiple Uint8Arrays.
 * Engines limit functions to 65K+ arguments.
 * @param arrays Array of Uint8Array elements
 * @returns Concatenated Uint8Array
 */
function concatBytes(...arrays: TArg<Uint8Array[]>): TRet<Uint8Array> {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    if (!isBytes(a)) throw new Error('Uint8Array expected');
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
/**
 * Creates DataView from Uint8Array
 * @param arr - bytes
 * @returns DataView
 */
const createView = (arr: TArg<Uint8Array>) =>
  new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
const _0n = /* @__PURE__ */ BigInt(0);
const _1n = /* @__PURE__ */ BigInt(1);
const _2n = /* @__PURE__ */ BigInt(2);
const _8n = /* @__PURE__ */ BigInt(8);
const _10n = /* @__PURE__ */ BigInt(10);
const _255n = /* @__PURE__ */ BigInt(255);

/**
 * Checks if the provided value is object-like for option/schema bags.
 * This intentionally matches noble-curves and noble-hashes by using the
 * `[object Object]` tag instead of rejecting class/proxy/env objects by prototype;
 * stricter checks caused compatibility reports in proxied environments.
 * Array, Uint8Array and others are not plain objects.
 * @param obj - The value to be checked.
 */
function isPlainObject(obj: any): boolean {
  return Object.prototype.toString.call(obj) === '[object Object]';
}

function isNum(num: unknown): num is number {
  return Number.isSafeInteger(num);
}
const hasOwn = (obj: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Miscellaneous helpers reused by the coder internals and tests.
 * @example
 * Reuse a couple of byte helpers without pulling in the full namespace.
 * ```ts
 * import { utils } from 'micro-packed';
 * const left = Uint8Array.of(1);
 * const right = Uint8Array.of(2);
 * utils.equalBytes(utils.concatBytes(left, right), Uint8Array.of(1, 2));
 * ```
 */
export const utils: TRet<{
  equalBytes: typeof equalBytes;
  isBytes: typeof isBytes;
  isCoder: typeof isCoder;
  checkBounds: typeof checkBounds;
  concatBytes: typeof concatBytes;
  createView: (arr: TArg<Uint8Array>) => DataView;
  isPlainObject: typeof isPlainObject;
}> = /* @__PURE__ */ Object.freeze({
  equalBytes,
  isBytes,
  isCoder,
  checkBounds,
  concatBytes,
  createView,
  isPlainObject,
});

// Types
/** Byte-array alias used throughout the public API. */
export type Bytes = Uint8Array;
/** Optional value helper used by conditional coders. */
export type Option<T> = T | undefined;
/** Coder encodes and decodes between two types. */
export interface Coder<F, T> {
  /**
   * Encodes (converts) a decoded value into its serialized representation.
   * @param from - Value to encode.
   * @returns Encoded representation.
   */
  encode(from: F): T;
  /**
   * Decodes (converts) a serialized value back into its decoded representation.
   * @param to - Encoded representation to decode.
   * @returns Decoded value.
   */
  decode(to: T): F;
}
/** BytesCoder converts value between a type and a byte array. */
export interface BytesCoder<T> extends Coder<T, Bytes> {
  /** Fixed-size hint in bytes, when known. */
  size?: number;
  /**
   * Encodes a value into a byte array.
   * @param data - Value to encode.
   * @returns Encoded bytes.
   */
  encode: (data: T) => Bytes;
  /**
   * Decodes a byte array into a value.
   * @param data - Bytes to decode.
   * @param opts - Reader options used while decoding. See {@link ReaderOpts}.
   * @returns Decoded value.
   */
  decode: (data: Bytes, opts?: ReaderOpts) => T;
}
/** BytesCoderStream converts value between a type and a byte array, using streams. */
export interface BytesCoderStream<T> {
  /** Fixed-size hint in bytes, when known. */
  size?: number;
  /**
   * Encodes a value into a Writer stream.
   * @param w - Writer stream.
   * @param value - Value to encode.
   */
  encodeStream: (w: Writer, value: T) => void;
  /**
   * Decodes a value from a Reader stream.
   * @param r - Reader stream.
   * @returns Decoded value.
   */
  decodeStream: (r: Reader) => T;
}
/** Full coder interface with both stream and byte-array helpers. */
export type CoderType<T> = BytesCoderStream<T> & BytesCoder<T>;
/** CoderType with a known fixed byte size. */
export type Sized<T> = CoderType<T> & { size: number };
/** Extract the decoded value type from a coder. */
export type UnwrapCoder<T> = T extends CoderType<infer U> ? U : T;
/**
 * Validation function. Should return value after validation.
 * Can be used to narrow types
 */
export type Validate<T> = (elm: T) => T;

/** Length descriptor accepted by variable-size coders. */
export type Length = CoderType<number> | CoderType<bigint> | number | Bytes | string | null;

// NOTE: we can't have terminator separate function, since it won't know about boundaries
// E.g. array of U16LE ([1,2,3]) would be [1, 0, 2, 0, 3, 0]
// But terminator will find array at index '1', which happens to be inside of an element itself
/**
 * Can be:
 * - Dynamic (CoderType)
 * - Fixed (number)
 * - Terminated (usually zero): Uint8Array with terminator
 * - Field path to field with length (string)
 * - Infinity (null) - decodes until end of buffer
 * Used in:
 * - bytes (string, prefix is implementation of bytes)
 * - array
 */
const lengthCoder = (len: Length) => {
  if (len !== null && typeof len !== 'string' && !isCoder(len) && !isBytes(len) && !isNum(len)) {
    // Constructor argument validation uses TypeError.
    // Stream/data failures keep contextual Error paths.
    throw new TypeError(
      `lengthCoder: expected null | number | Uint8Array | CoderType, got ${len} (${typeof len})`
    );
  }
  if (typeof len === 'number' && len < 0) throw new Error(`lengthCoder: wrong length=${len}`);
  if (isBytes(len) && !len.length) throw new Error('lengthCoder: empty terminator');
  return {
    encodeStream(w: TArg<Writer>, value: number | null) {
      if (len === null) return;
      if (isCoder(len)) return len.encodeStream(w, value);
      let byteLen;
      if (typeof len === 'number') byteLen = len;
      else if (typeof len === 'string') byteLen = Path.resolve((w as _Writer).stack, len);
      if (typeof byteLen === 'bigint') byteLen = Number(byteLen);
      if (byteLen === undefined || byteLen !== value)
        throw w.err(`Wrong length: ${byteLen} len=${len} exp=${value} (${typeof value})`);
    },
    decodeStream(r: TArg<Reader>) {
      let byteLen;
      if (isCoder(len)) byteLen = Number(len.decodeStream(r));
      else if (typeof len === 'number') byteLen = len;
      else if (typeof len === 'string') byteLen = Path.resolve((r as _Reader).stack, len);
      if (typeof byteLen === 'bigint') byteLen = Number(byteLen);
      // Dynamic signed or custom length coders can decode impossible lengths; reject before callers
      // use the value as a loop bound or byte count.
      if (!isNum(byteLen) || byteLen < 0) throw r.err(`Wrong length: ${byteLen}`);
      return byteLen;
    },
  };
};

type ArrLike<T> = Array<T> | ReadonlyArray<T>;
// prettier-ignore
/** Typed arrays supported by the utility helper types. */
export type TypedArray =
  | Uint8Array  | Int8Array | Uint8ClampedArray
  | Uint16Array | Int16Array
  | Uint32Array | Int32Array;

/** Writable version of a type, where readonly properties are made writable. */
export type Writable<T> = T extends {}
  ? T extends TypedArray
    ? T
    : {
        -readonly [P in keyof T]: Writable<T[P]>;
      }
  : T;
/** Union of object value types. */
export type Values<T> = T[keyof T];
/** Key helper that removes fields whose values are exactly `undefined`. */
export type NonUndefinedKey<T, K extends keyof T> = T[K] extends undefined ? never : K;
/** Key helper that keeps only nullable fields. */
export type NullableKey<T, K extends keyof T> = T[K] extends NonNullable<T[K]> ? never : K;
// Opt: value !== undefined, but value === T|undefined
/** Key helper for optional-but-present struct fields. */
export type OptKey<T, K extends keyof T> = NullableKey<T, K> & NonUndefinedKey<T, K>;
/** Key helper for required struct fields. */
export type ReqKey<T, K extends keyof T> = T[K] extends NonNullable<T[K]> ? K : never;

/** Object containing only optional keys from a struct shape. */
export type OptKeys<T> = Pick<T, { [K in keyof T]: OptKey<T, K> }[keyof T]>;
/** Object containing only required keys from a struct shape. */
export type ReqKeys<T> = Pick<T, { [K in keyof T]: ReqKey<T, K> }[keyof T]>;
/** Input object type accepted by `struct()`. */
export type StructInput<T extends Record<string, any>> = { [P in keyof ReqKeys<T>]: T[P] } & {
  [P in keyof OptKeys<T>]?: T[P];
};
/** Record of field names to coder instances for `struct()`. */
export type StructRecord<T extends Record<string, any>> = {
  [P in keyof T]: CoderType<T[P]>;
};

/** Generic decoded object bag used internally by nested coders. */
export type StructOut = Record<string, any>;
/** Padding function that takes an index and returns a padding value. */
export type PadFn = (i: number) => number;

/**
 * Small bitset structure to store position of ranges that have been read.
 * Can be more efficient when internal trees are utilized at the cost of complexity.
 * Needs `O(N/8)` memory for parsing.
 * Purpose: if there are pointers in parsed structure,
 * they can cause read of two distinct ranges:
 * [0-32, 64-128], which means 'pos' is not enough to handle them
 */
const Bitset = /* @__PURE__ */ Object.freeze({
  BITS: 32,
  FULL_MASK: -1 >>> 0, // 1<<32 will overflow
  len: (len: number) => {
    if (!isNum(len) || len < 0) throw new Error(`wrong len=${len}`);
    return Math.ceil(len / 32);
  },
  create: (len: number) => new Uint32Array(Bitset.len(len)),
  clean: (bs: TArg<Uint32Array>) => bs.fill(0),
  debug: (bs: TArg<Uint32Array>) =>
    Array.from(bs).map((i) => (i >>> 0).toString(2).padStart(32, '0')),
  checkLen: (bs: TArg<Uint32Array>, len: number) => {
    if (Bitset.len(len) === bs.length) return;
    throw new Error(`wrong length=${bs.length}. Expected: ${Bitset.len(len)}`);
  },
  chunkLen: (bsLen: number, pos: number, len: number) => {
    if (!isNum(bsLen) || bsLen < 0) throw new Error(`wrong bsLen=${bsLen}`);
    if (!isNum(pos) || pos < 0) throw new Error(`wrong pos=${pos}`);
    if (!isNum(len) || len < 0) throw new Error(`wrong len=${len}`);
    if (pos > bsLen - len) throw new Error(`wrong range=${pos}/${len} of ${bsLen}`);
  },
  set: (bs: TArg<Uint32Array>, chunk: number, value: number, allowRewrite = true) => {
    if (!isNum(chunk) || chunk < 0 || chunk >= bs.length) return false;
    if (!allowRewrite && (bs[chunk] & value) !== 0) return false;
    bs[chunk] |= value;
    return true;
  },
  pos: (pos: number, i: number) => ({
    chunk: Math.floor((pos + i) / 32),
    mask: 1 << (32 - ((pos + i) % 32) - 1),
  }),
  indices: (bs: TArg<Uint32Array>, len: number, invert = false) => {
    Bitset.checkLen(bs, len);
    const { FULL_MASK, BITS } = Bitset;
    const left = BITS - (len % BITS);
    const lastMask = left ? (FULL_MASK >>> left) << left : FULL_MASK;
    const res = [];
    for (let i = 0; i < bs.length; i++) {
      let c = bs[i];
      if (invert) c = ~c; // allows to gen unset elements
      // apply mask to last element, so we won't iterate non-existent items
      if (i === bs.length - 1) c &= lastMask;
      if (c === 0) continue; // fast-path
      for (let j = 0; j < BITS; j++) {
        const m = 1 << (BITS - j - 1);
        if (c & m) res.push(i * BITS + j);
      }
    }
    return res;
  },
  range: (arr: number[]) => {
    // Bitset.indices() returns sorted unique positions; this helper only merges adjacent runs.
    const res = [];
    let cur;
    for (const i of arr) {
      if (cur === undefined || i !== cur.pos + cur.length) res.push((cur = { pos: i, length: 1 }));
      else cur.length += 1;
    }
    return res;
  },
  rangeDebug: (bs: TArg<Uint32Array>, len: number, invert = false) =>
    `[${Bitset.range(Bitset.indices(bs, len, invert))
      .map((i) => `(${i.pos}/${i.length})`)
      .join(', ')}]`,
  setRange: (
    bs: TArg<Uint32Array>,
    bsLen: number,
    pos: number,
    len: number,
    allowRewrite = true
  ) => {
    Bitset.chunkLen(bsLen, pos, len);
    // Empty ranges are valid reader-bookkeeping no-ops; mask math below assumes at least one bit.
    if (len === 0) return true;
    const { FULL_MASK, BITS } = Bitset;
    // Try to set range with maximum efficiency:
    // - first chunk is always    '0000[1111]' (only right ones)
    // - middle chunks are set to '[1111 1111]' (all ones)
    // - last chunk is always     '[1111]0000' (only left ones)
    // - max operations:          (N/32) + 2 (first and last)
    const first = pos % BITS ? Math.floor(pos / BITS) : undefined;
    const lastPos = pos + len;
    const last = lastPos % BITS ? Math.floor(lastPos / BITS) : undefined;
    const canSet = (chunk: number, value: number) =>
      chunk >= 0 && chunk < bs.length && (bs[chunk] & value) === 0;
    if (!allowRewrite) {
      // Check the whole range before writing so a late overlap cannot leave earlier chunks mutated.
      if (first !== undefined && first === last) {
        if (!canSet(first, (FULL_MASK >>> (BITS - len)) << (BITS - len - pos))) return false;
      } else {
        if (first !== undefined && !canSet(first, FULL_MASK >>> pos % BITS)) return false;
        const start = first !== undefined ? first + 1 : pos / BITS;
        const end = last !== undefined ? last : lastPos / BITS;
        for (let i = start; i < end; i++) if (!canSet(i, FULL_MASK)) return false;
        if (last !== undefined && first !== last)
          if (!canSet(last, FULL_MASK << (BITS - (lastPos % BITS)))) return false;
      }
    }
    // special case, whole range inside single chunk
    if (first !== undefined && first === last)
      return Bitset.set(
        bs,
        first,
        (FULL_MASK >>> (BITS - len)) << (BITS - len - pos),
        allowRewrite
      );
    if (first !== undefined) {
      // first chunk
      if (!Bitset.set(bs, first, FULL_MASK >>> pos % BITS, allowRewrite)) return false;
    }
    // middle chunks
    const start = first !== undefined ? first + 1 : pos / BITS;
    const end = last !== undefined ? last : lastPos / BITS;
    for (let i = start; i < end; i++) if (!Bitset.set(bs, i, FULL_MASK, allowRewrite)) return false;
    if (last !== undefined && first !== last)
      if (!Bitset.set(bs, last, FULL_MASK << (BITS - (lastPos % BITS)), allowRewrite))
        // last chunk
        return false;
    return true;
  },
});

/** Path related utils (internal) */
type Path = { obj: StructOut; field?: string };
type PathStack = Path[];
export type _PathObjFn = (cb: (field: string, fieldFn: Function) => void) => void;
type PathUtils = {
  pushObj: (stack: PathStack, obj: StructOut, objFn: _PathObjFn) => void;
  path: (stack: PathStack) => string;
  err: (name: string, stack: PathStack, msg: string | Error) => Error;
  resolve: (stack: PathStack, path: string) => StructOut | undefined;
};
const Path: PathUtils = /* @__PURE__ */ Object.freeze({
  /**
   * Internal method for handling stack of paths (debug, errors, dynamic fields via path)
   * This callback shape forces stack cleanup by construction:
   * `.pop()` always happens after the wrapped function.
   * Also, this makes impossible:
   * - pushing field when stack is empty
   * - pushing field inside of field (real bug)
   * NOTE: we don't want to do '.pop' on error!
   */
  pushObj: (stack: PathStack, obj: StructOut, objFn: _PathObjFn): void => {
    const last: Path = { obj };
    stack.push(last);
    objFn((field: string, fieldFn: Function) => {
      last.field = field;
      // Intentionally keep last.field set on throw so Path.err() can report the failing leaf.
      fieldFn();
      last.field = undefined;
    });
    stack.pop();
  },
  path: (stack: PathStack): string => {
    const res = [];
    for (const i of stack) if (i.field !== undefined) res.push(i.field === '' ? '""' : i.field);
    // Path.err() uses this string for user-visible context. Empty keys need explicit rendering so
    // field("") is distinguishable from the root path; slash-containing keys are still raw.
    return res.join('/');
  },
  err: (name: string, stack: PathStack, msg: string | Error): Error => {
    const text = `${name}(${Path.path(stack)}): ${typeof msg === 'string' ? msg : msg.message}`;
    // Path context is the primary diagnostic. Do not attach `cause`: Node inspection expands nested
    // cause stacks and makes the original, path-prefixed failure harder to scan.
    // Keep specific validation classes after adding the path prefix. Otherwise public coder
    // APIs flatten inner TypeError / RangeError guards back to plain Error.
    const err =
      msg instanceof TypeError
        ? new TypeError(text)
        : msg instanceof RangeError
          ? new RangeError(text)
          : new Error(text);
    if (msg instanceof Error && msg.stack) {
      const from = `${msg.name}: ${msg.message}`;
      const to = `${err.name}: ${err.message}`;
      err.stack = msg.stack.startsWith(from) ? `${to}${msg.stack.slice(from.length)}` : msg.stack;
    }
    return err;
  },
  resolve: (stack: PathStack, path: string): StructOut | undefined => {
    const parts = path.split('/');
    // Leading '..' segments mean parent traversal and '/' separates nested fields, so literal
    // keys using those tokens are not addressable through this helper.
    const objPath = stack.map((i) => i.obj);
    let i = 0;
    for (; i < parts.length; i++) {
      if (parts[i] === '..') objPath.pop();
      else break;
    }
    let cur = objPath.pop();
    for (; i < parts.length; i++) {
      if (!cur || cur[parts[i]] === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  },
});

/** Options for the Reader class. */
export type ReaderOpts = {
  /** Allow decoding to finish with unread trailing bytes. */
  allowUnreadBytes?: boolean;
  /** Allow the same byte range to be read more than once through pointers. */
  allowMultipleReads?: boolean;
};
// These are safe API for external usage
/** Reader interface passed into stream decoders. */
export type Reader = {
  // Utils
  /** Current position in the buffer. */
  readonly pos: number;
  /** Number of bytes left in the buffer. */
  readonly leftBytes: number;
  /** Total number of bytes in the buffer. */
  readonly totalBytes: number;
  /**
   * Checks if the end of the buffer has been reached.
   * @returns `true` when the reader consumed the whole buffer.
   */
  isEnd(): boolean;
  /**
   * Creates an error with the given message. Adds information about current field path.
   * If Error object provided, saves original stack trace.
   * @param msg - The error message or an Error object.
   * @returns The created Error object.
   */
  err(msg: string | Error): Error;
  /**
   * Reads a specified number of bytes from the buffer.
   *
   * WARNING: Uint8Array is subarray of original buffer. Do not modify.
   * @param n - The number of bytes to read.
   * @param peek - If `true`, the bytes are read without advancing the position.
   * @returns The read bytes as a Uint8Array.
   */
  bytes(n: number, peek?: boolean): Uint8Array;
  /**
   * Reads a single byte from the buffer.
   * @param peek - If `true`, the byte is read without advancing the position.
   * @returns The read byte as a number.
   */
  byte(peek?: boolean): number;
  /**
   * Reads a specified number of bits from the buffer.
   * @param bits - The number of bits to read.
   * @returns The read bits as a number.
   */
  bits(bits: number): number;
  /**
   * Finds the first occurrence of a needle in the buffer.
   * @param needle - The needle to search for.
   * @param pos - The starting position for the search.
   * @returns The position of the first occurrence of the needle, or `undefined` if not found.
   */
  find(needle: Bytes, pos?: number): number | undefined;
  /**
   * Creates a new Reader instance at the specified offset.
   * Complex and unsafe API: currently only used in eth ABI parsing of pointers.
   * Required to break pointer boundaries inside arrays for complex structure.
   * Please use only if absolutely necessary!
   * @param n - The offset to create the new Reader at.
   * @returns A new Reader instance at the specified offset.
   */
  offsetReader(n: number): Reader;
};

/** Writer interface passed into stream encoders. */
export type Writer = {
  /**
   * Creates an error with the given message. Adds information about current field path.
   * If Error object provided, saves original stack trace.
   * @param msg - The error message or an Error object.
   * @returns The created Error object.
   */
  err(msg: string | Error): Error;
  /**
   * Writes a byte array to the buffer.
   * @param b - The byte array to write.
   */
  bytes(b: Bytes): void;
  /**
   * Writes a single byte to the buffer.
   * @param b - The byte to write.
   */
  byte(b: number): void;
  /**
   * Writes a specified number of bits to the buffer.
   * @param value - The value to write.
   * @param bits - The number of bits to write.
   */
  bits(value: number, bits: number): void;
};

/**
 * Internal structure. Reader class for reading from a byte array.
 * `stack` is internal: for debugger and logging
 * @class Reader
 */
class _Reader implements Reader {
  pos = 0;
  readonly data: Bytes;
  readonly opts: ReaderOpts;
  readonly stack: PathStack;
  private parent: _Reader | undefined;
  private parentOffset: number;
  private bitBuf = 0;
  private bitPos = 0;
  private bs: Uint32Array | undefined; // bitset
  private view: DataView;
  constructor(
    data: Bytes,
    opts: ReaderOpts = {},
    stack: PathStack = [],
    parent: _Reader | undefined = undefined,
    parentOffset: number = 0
  ) {
    this.data = data;
    this.opts = opts;
    this.stack = stack;
    this.parent = parent;
    this.parentOffset = parentOffset;
    this.view = createView(data);
  }
  /** Internal method for pointers. */
  _enablePointers(): void {
    // Pointer decoding enables tracking before the pointed child reader starts consuming bytes, so
    // only the root reader owns the bitset and seeds it from the already-consumed prefix.
    if (this.parent) return this.parent._enablePointers();
    if (this.bs) return;
    this.bs = Bitset.create(this.data.length);
    Bitset.setRange(this.bs, this.data.length, 0, this.pos, this.opts.allowMultipleReads);
  }
  private markBytesBS(pos: number, len: number): boolean {
    if (this.parent) return this.parent.markBytesBS(this.parentOffset + pos, len);
    if (!len) return true;
    // Before pointers are enabled there is no bitset yet, so linear cursor checks remain the only
    // guard; overlap tracking starts only after _enablePointers() allocates the root bitset.
    if (!this.bs) return true;
    return Bitset.setRange(this.bs, this.data.length, pos, len, false);
  }
  private markBytes(len: number): boolean {
    const pos = this.pos;
    const res = this.markBytesBS(pos, len);
    // Keep failed overlap reads at their start so diagnostics point at the repeated span.
    if (!this.opts.allowMultipleReads && !res)
      throw this.err(`multiple read pos=${pos} len=${len}`);
    this.pos += len;
    return res;
  }

  pushObj(obj: StructOut, objFn: _PathObjFn): void {
    return Path.pushObj(this.stack, obj, objFn);
  }
  readView(n: number, fn: (view: DataView, pos: number) => number): number {
    if (!isNum(n) || n < 0) throw this.err(`readView: wrong length=${n}`);
    if (this.pos + n > this.data.length) throw this.err('readView: Unexpected end of buffer');
    const res = fn(this.view, this.pos);
    this.markBytes(n);
    return res;
  }
  // read bytes by absolute offset
  absBytes(n: number): Uint8Array {
    if (!isNum(n) || n < 0 || n > this.data.length) throw new Error('Unexpected end of buffer');
    return this.data.subarray(n);
  }
  finish(): void {
    // ReaderOpts documents allowUnreadBytes as "Allow decoding to finish with unread trailing
    // bytes." Prefix decoders may intentionally parse only a value from a larger byte array, so
    // this skips all final unread-input checks, including residual bits and pointer-read gaps.
    if (this.opts.allowUnreadBytes) return;
    if (this.bitPos) {
      throw this.err(
        `${this.bitPos} bits left after unpack: ${baseHex.encode(this.data.subarray(this.pos))}`
      );
    }
    if (this.bs && !this.parent) {
      const notRead = Bitset.indices(this.bs, this.data.length, true);
      if (notRead.length) {
        const formatted = Bitset.range(notRead)
          .map(
            ({ pos, length }) =>
              `(${pos}/${length})[${baseHex.encode(this.data.subarray(pos, pos + length))}]`
          )
          .join(', ');
        throw this.err(`unread byte ranges: ${formatted} (total=${this.data.length})`);
      } else return; // all bytes read, everything is ok
    }
    // Default: no pointers enabled
    if (!this.isEnd()) {
      throw this.err(
        `${this.leftBytes} bytes ${this.bitPos} bits left after unpack: ${baseHex.encode(
          this.data.subarray(this.pos)
        )}`
      );
    }
  }
  // User methods
  err(msg: string | Error): Error {
    return Path.err('Reader', this.stack, msg);
  }
  offsetReader(n: number): _Reader {
    if (!isNum(n) || n < 0 || n > this.data.length)
      throw this.err('offsetReader: Unexpected end of buffer');
    return new _Reader(this.absBytes(n), this.opts, this.stack, this, n);
  }
  bytes(n: number, peek = false): Uint8Array {
    if (this.bitPos) throw this.err('readBytes: bitPos not empty');
    if (!isNum(n) || n < 0) throw this.err(`readBytes: wrong length=${n}`);
    if (this.pos + n > this.data.length) throw this.err('readBytes: Unexpected end of buffer');
    const slice = this.data.subarray(this.pos, this.pos + n);
    if (!peek) this.markBytes(n);
    return slice;
  }
  byte(peek = false): number {
    if (this.bitPos) throw this.err('readByte: bitPos not empty');
    if (this.pos + 1 > this.data.length) throw this.err('readByte: Unexpected end of buffer');
    const data = this.data[this.pos];
    if (!peek) this.markBytes(1);
    return data;
  }
  get leftBytes(): number {
    return this.data.length - this.pos;
  }
  get totalBytes(): number {
    return this.data.length;
  }
  isEnd(): boolean {
    return this.pos >= this.data.length && !this.bitPos;
  }
  progress(): number {
    return this.pos * 8 - this.bitPos;
  }
  // bits are read in BE mode (left to right): (0b1000_0000).readBits(1) == 1
  bits(bits: number): number {
    // Reject before bitwise shifts: JS coerces negative/fractional shift counts into other widths.
    if (!isNum(bits) || bits < 0) throw this.err(`BitReader: wrong length=${bits}`);
    if (bits > 32) throw this.err('BitReader: cannot read more than 32 bits in single call');
    let out = 0;
    while (bits) {
      if (!this.bitPos) {
        this.bitBuf = this.byte();
        this.bitPos = 8;
      }
      const take = Math.min(bits, this.bitPos);
      this.bitPos -= take;
      out = (out << take) | ((this.bitBuf >> this.bitPos) & (2 ** take - 1));
      this.bitBuf &= 2 ** this.bitPos - 1;
      bits -= take;
    }
    // Fix signed integers
    return out >>> 0;
  }
  find(needle: Bytes, pos: number = this.pos): number | undefined {
    if (!isBytes(needle)) throw this.err(`find: needle is not bytes! ${needle}`);
    if (this.bitPos) throw this.err('find: bitPos not empty');
    if (!needle.length) throw this.err(`find: needle is empty`);
    if (!isNum(pos) || pos < 0) throw this.err(`find: wrong pos=${pos}`);
    return findBytes(needle, this.data, pos);
  }
}

/**
 * Internal structure. Writer class for writing to a byte array.
 * The `stack` argument of constructor is internal, for debugging and logs.
 * @class Writer
 */
class _Writer implements Writer {
  pos: number = 0;
  readonly stack: PathStack;
  // We could have a single buffer here and re-alloc it with
  // x1.5-2 size each time it full, but it will be slower:
  // basic/encode bench: 395ns -> 560ns
  private buffers: Bytes[] = [];
  private cleanBuffers: Bytes[] = [];
  ptrs: { pos: number; ptr: CoderType<number>; buffer: Bytes }[] = [];
  private bitBuf = 0;
  private bitPos = 0;
  private viewBuf = new Uint8Array(8);
  private view: DataView;
  private finished = false;
  constructor(stack: PathStack = []) {
    this.stack = stack;
    this.view = createView(this.viewBuf);
  }
  pushObj(obj: StructOut, objFn: _PathObjFn): void {
    return Path.pushObj(this.stack, obj, objFn);
  }
  writeView(len: number, fn: (view: DataView) => void): void {
    if (this.finished) throw this.err('buffer: finished');
    if (!isNum(len) || len < 0 || len > 8) throw new Error(`wrong writeView length=${len}`);
    fn(this.view);
    const buf = this.viewBuf.slice(0, len);
    this.bytes(buf);
    this.cleanBuffers.push(buf);
    this.viewBuf.fill(0);
  }
  // User methods
  err(msg: string | Error): Error {
    // Finished-state guards call err('buffer: finished'), so err itself must not recurse there.
    return Path.err('Writer', this.stack, msg);
  }
  bytes(b: Bytes): void {
    if (this.finished) throw this.err('buffer: finished');
    if (this.bitPos) throw this.err('writeBytes: ends with non-empty bit buffer');
    // Keep caller-provided buffers by reference until finish(); mutating them afterwards changes
    // the encoded output.
    this.buffers.push(b);
    this.pos += b.length;
  }
  byte(b: number): void {
    if (this.finished) throw this.err('buffer: finished');
    if (this.bitPos) throw this.err('writeByte: ends with non-empty bit buffer');
    if (!isNum(b) || b < 0 || b > 255) throw this.err(`writeByte: wrong value=${b}`);
    const buf = new Uint8Array([b]);
    this.buffers.push(buf);
    this.cleanBuffers.push(buf);
    this.pos++;
  }
  finish(clean = true): Bytes {
    if (this.finished) throw this.err('buffer: finished');
    if (this.bitPos) throw this.err('buffer: ends with non-empty bit buffer');
    // Can't use concatBytes, because it limits amount of arguments (65K).
    const buffers = this.buffers.concat(this.ptrs.map((i) => i.buffer));
    const sum = buffers.map((b) => b.length).reduce((a, b) => a + b, 0);
    const buf = new Uint8Array(sum);
    for (let i = 0, pad = 0; i < buffers.length; i++) {
      const a = buffers[i];
      buf.set(a, pad);
      pad += a.length;
    }

    for (let pos = this.pos, i = 0; i < this.ptrs.length; i++) {
      const ptr = this.ptrs[i];
      buf.set(ptr.ptr.encode(pos), ptr.pos);
      pos += ptr.buffer.length;
    }
    // Cleanup
    if (clean) {
      // bytes() keeps caller-provided buffers by reference, so only writer-owned buffers are tracked.
      for (const b of this.cleanBuffers) b.fill(0);
      this.buffers = [];
      this.cleanBuffers = [];
      for (const p of this.ptrs) p.buffer.fill(0);
      this.ptrs = [];
      this.finished = true;
      this.bitBuf = 0;
    }
    return buf;
  }
  bits(value: number, bits: number): void {
    if (this.finished) throw this.err('buffer: finished');
    // Reject before bitwise shifts: JS coerces negative/fractional values and widths.
    if (!isNum(bits) || bits < 0) throw this.err(`writeBits: wrong length=${bits}`);
    if (bits > 32) throw this.err('writeBits: cannot write more than 32 bits in single call');
    if (!isNum(value) || value < 0) throw this.err(`writeBits: wrong value=${value}`);
    if (value >= 2 ** bits) throw this.err(`writeBits: value (${value}) >= 2**bits (${bits})`);
    while (bits) {
      const take = Math.min(bits, 8 - this.bitPos);
      this.bitBuf = (this.bitBuf << take) | (value >> (bits - take));
      this.bitPos += take;
      bits -= take;
      value &= 2 ** bits - 1;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        const buf = new Uint8Array([this.bitBuf]);
        this.buffers.push(buf);
        this.cleanBuffers.push(buf);
        this.pos++;
      }
    }
  }
}
// Immutable LE<->BE
const swapEndianness = (b: TArg<Bytes>): TRet<Bytes> => Uint8Array.from(b).reverse();
/** Internal function for checking bit bounds of bigint in signed/unsinged form */
function checkBounds(value: bigint, bits: bigint, signed: boolean): void {
  if (signed) {
    if (bits <= _0n) throw new Error(`checkBounds: signed bits must be positive, got ${bits}`);
    // [-(2**(32-1)), 2**(32-1)-1]
    const signBit = _2n ** (bits - _1n);
    if (value < -signBit || value >= signBit)
      throw new Error(`value out of signed bounds. Expected ${-signBit} <= ${value} < ${signBit}`);
  } else {
    // [0, 2**32-1]
    const max = _2n ** bits;
    if (_0n > value || value >= max)
      throw new Error(`value out of unsigned bounds. Expected 0 <= ${value} < ${max}`);
  }
}

function _wrap<T>(inner: TArg<BytesCoderStream<T>>): CoderType<T> {
  const _inner = inner as BytesCoderStream<T>;
  return {
    // NOTE: we cannot export validate here, since it is likely mistake.
    // Raw inner throws propagate unchanged; path-aware errors must use w.err/r.err or validate().
    encodeStream: _inner.encodeStream,
    decodeStream: _inner.decodeStream,
    size: _inner.size,
    encode: (value: T): TRet<Bytes> => {
      const w = new _Writer();
      _inner.encodeStream(w, value);
      return w.finish() as TRet<Bytes>;
    },
    decode: (data: TArg<Bytes>, opts: ReaderOpts = {}): T => {
      const r = new _Reader(data, opts);
      const res = _inner.decodeStream(r);
      r.finish();
      return res;
    },
  };
}

/**
 * Validates a value before encoding and after decoding using a provided function.
 * @param inner - The inner CoderType.
 * @param fn - The validation function.
 * @returns CoderType which check value with validation function.
 * @throws On wrong inner coder or validator argument types. {@link TypeError}
 * @example
 * Reject values outside the accepted range during both encode and decode.
 * ```ts
 * import * as P from 'micro-packed';
 * const val = (n: number) => {
 *   if (n > 10) throw new Error(`${n} > 10`);
 *   return n;
 * };
 *
 * // Checks that values are <= 10 during encoding and decoding.
 * const RangedInt = P.validate(P.U32LE, val);
 * ```
 */
export function validate<T>(inner: CoderType<T>, fn: Validate<T>): CoderType<T> {
  if (!isCoder(inner)) throw new TypeError(`validate: invalid inner value ${inner}`);
  if (typeof fn !== 'function') throw new TypeError('validate: fn should be function');
  return _wrap({
    size: inner.size,
    encodeStream: (w: TArg<Writer>, value: T) => {
      let res;
      try {
        res = fn(value);
      } catch (e) {
        // Validator callbacks are caller code: if they throw non-Error garbage, diagnostics are on
        // them. Review policy: "if they throw garbage, then it is on them".
        throw w.err(e as Error);
      }
      inner.encodeStream(w, res);
    },
    decodeStream: (r: TArg<Reader>): T => {
      const res = inner.decodeStream(r);
      try {
        return fn(res);
      } catch (e) {
        throw r.err(e as Error);
      }
    },
  });
}

/**
 * Wraps a stream encoder into a generic encoder and optionally validation function
 * @param inner - Stream coder with optional validation hook.
 * @returns The wrapped CoderType.
 * @throws On wrong wrapped stream-coder shapes. {@link TypeError}
 * @example
 * Start from stream methods, then add validation if needed.
 * ```ts
 * import * as P from 'micro-packed';
 * const U8 = P.wrap({
 *   encodeStream: (w, value) => w.byte(value),
 *   decodeStream: (r) => r.byte(),
 * });
 * const checkedU8 = P.wrap({
 *   encodeStream: (w, value) => w.byte(value),
 *   decodeStream: (r) => r.byte(),
 *   validate: (n: number) => {
 *    if (n > 10) throw new Error(`${n} > 10`);
 *    return n;
 *   }
 * });
 * ```
 */
// Keep this as a plain contextual object type instead of TArg<>/TRet<> helpers:
// recursive object mapping breaks unannotated encodeStream/decodeStream parameters,
// and _wrap() already returns the CoderType<T> shape without byte-array normalization.
export const wrap = <T>(inner: {
  size?: number;
  encodeStream: (w: Writer, value: T) => void;
  decodeStream: (r: Reader) => T;
  validate?: Validate<T>;
}): CoderType<T> => {
  const _inner = inner as BytesCoderStream<T> & { validate?: Validate<T> };
  // Public wrap() is the boundary for raw stream coders; reject malformed shapes before a
  // half-constructed coder fails later during encode/decode.
  if (!isPlainObject(_inner)) throw new TypeError(`wrap: invalid inner value ${_inner}`);
  if (typeof _inner.encodeStream !== 'function')
    throw new TypeError('wrap: encodeStream should be function');
  if (typeof _inner.decodeStream !== 'function')
    throw new TypeError('wrap: decodeStream should be function');
  if (_inner.size !== undefined && (!isNum(_inner.size) || _inner.size < 0))
    throw new TypeError(`wrap: invalid size ${_inner.size}`);
  if (_inner.validate !== undefined && typeof _inner.validate !== 'function')
    throw new TypeError('wrap: validate should be function');
  const res = _wrap(_inner);
  return _inner.validate !== undefined ? validate(res, _inner.validate) : res;
};

const isBaseCoder = (elm: any) =>
  isPlainObject(elm) && typeof elm.decode === 'function' && typeof elm.encode === 'function';

/**
 * Checks if the given value is a CoderType.
 * @param elm - The value to check.
 * @returns True if the value is a CoderType, false otherwise.
 * @example
 * Guard unknown values before calling encode/decode helpers on them.
 * ```ts
 * import { isCoder, U8 } from 'micro-packed';
 * isCoder(U8);
 * ```
 */
export function isCoder<T>(elm: any): elm is CoderType<T> {
  return (
    isPlainObject(elm) &&
    isBaseCoder(elm) &&
    typeof elm.encodeStream === 'function' &&
    typeof elm.decodeStream === 'function' &&
    (elm.size === undefined || (isNum(elm.size) && elm.size >= 0))
  );
}

// Coders (like in @scure/base) for common operations

/**
 * Base coder for working with dictionaries (records, objects, key-value map)
 * Dictionary is dynamic type like: `[key: string, value: any][]`
 * @returns base coder that encodes/decodes between arrays of key-value tuples and dictionaries.
 * @example
 * Convert between tuple entries and a plain object record.
 * ```ts
 * import * as P from 'micro-packed';
 * const dict: P.CoderType<Record<string, number>> = P.apply(
 *  P.array(P.U16BE, P.tuple([P.cstring, P.U32LE] as const)),
 *  P.coders.dict()
 * );
 * ```
 */
function dict<T>(): BaseCoder<[string, T][], Record<string, T>> {
  return {
    encode: (from: [string, T][]): Record<string, T> => {
      if (!Array.isArray(from)) throw new Error('array expected');
      const to: Record<string, T> = {};
      const seen = new Set<string>();
      for (const item of from) {
        if (!Array.isArray(item) || item.length !== 2)
          throw new Error(`array of two elements expected`);
        const name = item[0];
        const value = item[1];
        validateFieldName(name, 'dict: key');
        // Stored undefined is still a present key, so duplicate detection cannot inspect values.
        if (seen.has(name)) throw new Error(`key(${name}) appears twice in struct`);
        seen.add(name);
        to[name] = value;
      }
      return to;
    },
    decode: (to: Record<string, T>): [string, T][] => {
      if (!isPlainObject(to)) throw new Error(`expected plain object, got ${to}`);
      for (const name in to) validateFieldName(name, 'dict: key');
      return Object.entries(to);
    },
  };
}
/**
 * Safely converts bigint to number.
 * Sometimes pointers / tags use u64 or other big numbers which cannot be represented by number,
 * but we still can use them since real value will be smaller than u32
 */
const numberBigint: BaseCoder<bigint, number> = /* @__PURE__ */ Object.freeze({
  encode: (from: bigint): number => {
    if (typeof from !== 'bigint') throw new Error(`expected bigint, got ${typeof from}`);
    if (from > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error(`element bigger than MAX_SAFE_INTEGER=${from}`);
    // Number() silently rounds bigint values outside the safe integer range on either side.
    if (from < BigInt(Number.MIN_SAFE_INTEGER))
      throw new Error(`element smaller than MIN_SAFE_INTEGER=${from}`);
    return Number(from);
  },
  decode: (to: number): bigint => {
    if (!isNum(to)) throw new Error('element is not a safe integer');
    return BigInt(to);
  },
});
// TODO: replace map with this?
type Enum = { [k: string]: number | string } & { [k: number]: string };
// Doesn't return numeric keys, so it's fine
type EnumKeys<T extends Enum> = keyof T;
/**
 * Base coder for working with TypeScript enums.
 * @param e - TypeScript enum.
 * @returns base coder that encodes/decodes between numbers and enum keys.
 * @example
 * Map enum numbers to their string keys and back.
 * ```ts
 * import * as P from 'micro-packed';
 * enum Color { Red, Green, Blue }
 * const colorCoder = P.coders.tsEnum(Color);
 * colorCoder.encode(Color.Red); // 'Red'
 * colorCoder.decode('Green'); // 1
 * ```
 */
function tsEnum<T extends Enum>(e: T): BaseCoder<number, EnumKeys<T>> {
  if (!isPlainObject(e)) throw new Error('plain object expected');
  return {
    encode: (from: number): string => {
      if (!isNum(from) || !(from in e)) throw new Error(`wrong value ${from}`);
      return e[from];
    },
    decode: (to: string): number => {
      if (typeof to !== 'string') throw new Error(`wrong value ${typeof to}`);
      const value = e[to];
      // TypeScript numeric enums include reverse-map keys like "0"; decode accepts names only.
      if (!hasOwn(e, to) || !isNum(value)) throw new Error(`wrong value ${to}`);
      return value;
    },
  };
}
/**
 * Base coder for working with decimal numbers.
 * @param precision - Number of decimal places.
 * @param round - Round fraction part if bigger than precision (throws error by default)
 * @returns base coder that encodes/decodes between bigints and decimal strings.
 * @example
 * Convert bigint amounts into fixed-precision decimal strings.
 * ```ts
 * import * as P from 'micro-packed';
 * const decimal8 = P.coders.decimal(8);
 * decimal8.encode(630880845n); // '6.30880845'
 * decimal8.decode('6.30880845'); // 630880845n
 * ```
 */
function decimal(precision: number, round = false): Coder<bigint, string> {
  if (!isNum(precision) || precision < 0)
    throw new Error(`decimal/precision: wrong value ${precision}`);
  if (typeof round !== 'boolean')
    throw new Error(`decimal/round: expected boolean, got ${typeof round}`);
  const decimalMask = _10n ** BigInt(precision);
  return {
    encode: (from: bigint): string => {
      if (typeof from !== 'bigint') throw new Error(`expected bigint, got ${typeof from}`);
      let s = (from < _0n ? -from : from).toString(10);
      let sep = s.length - precision;
      if (sep < 0) {
        s = s.padStart(s.length - sep, '0');
        sep = 0;
      }
      let i = s.length - 1;
      for (; i >= sep && s[i] === '0'; i--);
      let int = s.slice(0, sep);
      let frac = s.slice(sep, i + 1);
      if (!int) int = '0';
      if (from < _0n) int = '-' + int;
      if (!frac) return int;
      return `${int}.${frac}`;
    },
    decode: (to: string): bigint => {
      if (typeof to !== 'string') throw new Error(`expected string, got ${typeof to}`);
      let neg = false;
      if (to.startsWith('-')) {
        neg = true;
        to = to.slice(1);
      }
      if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(to)) throw new Error(`wrong string value=${to}`);
      let sep = to.indexOf('.');
      sep = sep === -1 ? to.length : sep;
      // Split by separator and strip trailing zeros from fraction.
      // Always returns [string, string]; .split() doesn't.
      const intS = to.slice(0, sep);
      const fracS = to.slice(sep + 1).replace(/0+$/, '');
      const int = BigInt(intS) * decimalMask;
      if (!round && fracS.length > precision) {
        throw new Error(
          `fractional part cannot be represented with this precision (num=${to}, prec=${precision})`
        );
      }
      const fracLen = Math.min(fracS.length, precision);
      const frac = BigInt(fracS.slice(0, fracLen)) * _10n ** BigInt(precision - fracLen);
      const value = int + frac;
      // All negative zero spellings collapse to 0n, so reject after parsing.
      if (neg && value === _0n) throw new Error(`negative zero is not allowed`);
      return neg ? -value : value;
    },
  };
}

// TODO: export from @scure/base?
type BaseInput<F> = F extends BaseCoder<infer T, any> ? T : never;
type BaseOutput<F> = F extends BaseCoder<any, infer T> ? T : never;

/**
 * Combines multiple coders into a single coder, allowing conditional
 * encoding/decoding based on input.
 * Acts as a parser combinator, splitting complex conditional coders into smaller parts.
 *
 *   `encode = [Ae, Be]; decode = [Ad, Bd]`
 *   ->
 *   `match([{encode: Ae, decode: Ad}, {encode: Be; decode: Bd}])`
 *
 * @param lst - Array of coders to match.
 * @returns Combined coder for conditional encoding/decoding.
 */
function match<
  L extends BaseCoder<unknown | undefined, unknown | undefined>[],
  I = { [K in keyof L]: NonNullable<BaseInput<L[K]>> }[number],
  O = { [K in keyof L]: NonNullable<BaseOutput<L[K]>> }[number],
>(lst: L): BaseCoder<I, O> {
  if (!Array.isArray(lst)) throw new Error(`expected array, got ${typeof lst}`);
  for (const i of lst) if (!isBaseCoder(i)) throw new Error(`wrong base coder ${i}`);
  return {
    encode: (from: I): O => {
      for (const c of lst) {
        let elm;
        try {
          elm = c.encode(from);
        } catch {
          // match() is a branch selector: coders may signal "not this branch" by throwing.
          continue;
        }
        if (elm !== undefined) return elm as O;
      }
      throw new Error(`match/encode: cannot find match in ${from}`);
    },
    decode: (to: O): I => {
      for (const c of lst) {
        let elm;
        try {
          elm = c.decode(to);
        } catch {
          // match() is a branch selector: coders may signal "not this branch" by throwing.
          continue;
        }
        if (elm !== undefined) return elm as I;
      }
      throw new Error(`match/decode: cannot find match in ${to}`);
    },
  };
}
/** Reverses direction of coder */
const reverse = <F, T>(coder: Coder<F, T>): Coder<T, F> => {
  if (!isBaseCoder(coder)) throw new Error('BaseCoder expected');
  // Call through the source coder so method-style encode/decode implementations keep their receiver.
  return { encode: (to: T) => coder.decode(to), decode: (from: F) => coder.encode(from) };
};

/**
 * Collection of reusable base coders and helpers.
 * @example
 * Build a reusable decimal-string adapter.
 * ```ts
 * import { coders } from 'micro-packed';
 * const decimal2 = coders.decimal(2);
 * decimal2.encode(123n); // '1.23'
 * ```
 */
export const coders: {
  dict: typeof dict;
  numberBigint: BaseCoder<bigint, number>;
  tsEnum: typeof tsEnum;
  decimal: typeof decimal;
  match: typeof match;
  reverse: <F, T>(coder: Coder<F, T>) => Coder<T, F>;
} = /* @__PURE__ */ Object.freeze({ dict, numberBigint, tsEnum, decimal, match, reverse });

/**
 * CoderType for parsing individual bits.
 * NOTE: Structure should parse whole amount of bytes before it can start parsing byte-level elements.
 * @param len - Number of bits to parse.
 * @returns CoderType representing the parsed bits.
 * @throws On invalid bit-length configuration or bit values. {@link Error}
 * @throws On wrong argument types forwarded into wrapped numeric validators. {@link TypeError}
 * @example
 * Pack several bit fields into a single byte.
 * ```ts
 * import * as P from 'micro-packed';
 * const s = P.struct({ magic: P.bits(1), version: P.bits(1), tag: P.bits(4), len: P.bits(2) });
 * ```
 */
export const bits = (len: number): CoderType<number> => {
  // Reader/Writer bit helpers operate on one 0..32-bit chunk; reject impossible coders up front.
  if (!isNum(len) || len < 0 || len > 32)
    throw new Error(`bits: wrong length ${len} (${typeof len})`);
  return wrap({
    encodeStream: (w: TArg<Writer>, value: number) => w.bits(value, len),
    decodeStream: (r: TArg<Reader>): number => r.bits(len),
    validate: (value: number) => {
      if (!isNum(value)) throw new Error(`bits: wrong value ${value}`);
      return value;
    },
  });
};

/**
 * CoderType for working with bigint values.
 * Unsized bigint values should be wrapped in a container (e.g., bytes or string).
 *
 * `0n = Uint8Array.of()`
 *
 * `1n = new Uint8Array([1n])`
 *
 * Please open issue, if you need different behavior for zero.
 *
 * @param size - Size of the bigint in bytes.
 * @param le - Whether to use little-endian byte order.
 * @param signed - Whether the bigint is signed.
 * @param sized - Whether the bigint should have a fixed size.
 * @returns CoderType representing the bigint value.
 * @throws On invalid bigint coder configuration or out-of-bounds bigint values. {@link Error}
 * @throws On wrong builder argument or wrapped numeric value types. {@link TypeError}
 * @example
 * Define a 512-bit unsigned big-endian integer coder.
 * ```ts
 * import * as P from 'micro-packed';
 * // Define a CoderType for a 512-bit unsigned big-endian integer.
 * const U512BE = P.bigint(64, false, false, true);
 * ```
 */
export const bigint = (
  size: number,
  le = false,
  signed = false,
  sized = true
): CoderType<bigint> => {
  // Size is used in exponent math below; reject non-positive widths before raw RangeErrors leak.
  if (!isNum(size) || size <= 0) throw new Error(`bigint/size: wrong value ${size}`);
  if (typeof le !== 'boolean') throw new Error(`bigint/le: expected boolean, got ${typeof le}`);
  if (typeof signed !== 'boolean')
    throw new Error(`bigint/signed: expected boolean, got ${typeof signed}`);
  if (typeof sized !== 'boolean')
    throw new Error(`bigint/sized: expected boolean, got ${typeof sized}`);
  const bLen = BigInt(size);
  const signBit = _2n ** (_8n * bLen - _1n);
  return wrap({
    size: sized ? size : undefined,
    encodeStream: (w: TArg<Writer>, value: bigint) => {
      const zero = value === _0n;
      if (signed && value < 0) value = value | signBit;
      const b = [];
      for (let i = 0; i < size; i++) {
        b.push(Number(value & _255n));
        value >>= _8n;
      }
      let res = new Uint8Array(b).reverse();
      if (!sized) {
        let pos = 0;
        if (signed) {
          // Keep signed unsized encodings minimal but unambiguous for input-width signed decode.
          for (; pos < res.length - 1; pos++) {
            const next = res[pos + 1];
            if (res[pos] === 0 && (next & 128) === 0) continue;
            if (res[pos] === 255 && (next & 128) !== 0) continue;
            break;
          }
          res = zero ? res.subarray(res.length) : res.subarray(pos);
        } else {
          for (; pos < res.length; pos++) if (res[pos] !== 0) break;
          res = res.subarray(pos); // remove leading zeros
        }
      }
      w.bytes(le ? res.reverse() : res);
    },
    decodeStream: (r: TArg<Reader>): bigint => {
      // TODO: for le we can read until first zero?
      const value = r.bytes(sized ? size : Math.min(size, r.leftBytes));
      const b = le ? value : swapEndianness(value);
      let res = _0n;
      for (let i = 0; i < b.length; i++) res |= BigInt(b[i]) << (_8n * BigInt(i));
      const sBit = sized || !value.length ? signBit : _2n ** (_8n * BigInt(value.length) - _1n);
      if (signed && res & sBit) res = (res ^ sBit) - sBit;
      return res;
    },
    validate: (value: bigint) => {
      if (typeof value !== 'bigint') throw new Error(`bigint: invalid value: ${value}`);
      checkBounds(value, _8n * bLen, !!signed);
      return value;
    },
  });
};
/** Unsigned 256-bit little-endian integer CoderType. */
export const U256LE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(32, true)
);
/** Unsigned 256-bit big-endian integer CoderType. */
export const U256BE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(32, false)
);
/** Signed 256-bit little-endian integer CoderType. */
export const I256LE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(32, true, true)
);
/** Signed 256-bit big-endian integer CoderType. */
export const I256BE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(32, false, true)
);
/** Unsigned 128-bit little-endian integer CoderType. */
export const U128LE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(16, true)
);
/** Unsigned 128-bit big-endian integer CoderType. */
export const U128BE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(16, false)
);
/** Signed 128-bit little-endian integer CoderType. */
export const I128LE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(16, true, true)
);
/** Signed 128-bit big-endian integer CoderType. */
export const I128BE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(16, false, true)
);
/** Unsigned 64-bit little-endian integer CoderType. */
export const U64LE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(8, true)
);
/** Unsigned 64-bit big-endian integer CoderType. */
export const U64BE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(8, false)
);
/** Signed 64-bit little-endian integer CoderType. */
export const I64LE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(8, true, true)
);
/** Signed 64-bit big-endian integer CoderType. */
export const I64BE: CoderType<bigint> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ bigint(8, false, true)
);

/**
 * CoderType for working with number values (up to 6 bytes/48 bits).
 * Unsized int values should be wrapped in a container (e.g., bytes or string).
 *
 * `0 = Uint8Array.of()`
 *
 * `1 = new Uint8Array([1n])`
 *
 * Please open issue, if you need different behavior for zero.
 *
 * @param size - Size of the number in bytes.
 * @param le - Whether to use little-endian byte order.
 * @param signed - Whether the number is signed.
 * @param sized - Whether the number should have a fixed size.
 * @returns CoderType representing the number value.
 * @throws On invalid number-coder configuration or out-of-bounds values. {@link Error}
 * @throws On wrong builder argument or wrapped numeric value types. {@link TypeError}
 * @example
 * Create a coder for JavaScript numbers up to 48 bits wide.
 * ```ts
 * import * as P from 'micro-packed';
 * const int24 = P.int(3, false); // Define a coder for a 24-bit unsigned big-endian integer
 * ```
 */
export const int = (size: number, le = false, signed = false, sized = true): CoderType<number> => {
  if (!isNum(size) || size <= 0) throw new Error(`int/size: wrong value ${size}`);
  if (typeof le !== 'boolean') throw new Error(`int/le: expected boolean, got ${typeof le}`);
  if (typeof signed !== 'boolean')
    throw new Error(`int/signed: expected boolean, got ${typeof signed}`);
  if (typeof sized !== 'boolean')
    throw new Error(`int/sized: expected boolean, got ${typeof sized}`);
  if (size > 6) throw new Error('int supports size up to 6 bytes (48 bits): use bigints instead');
  return apply(bigint(size, le, signed, sized), coders.numberBigint);
};

type ViewCoder = {
  read: (view: DataView, pos: number) => number;
  write: (view: DataView, value: number) => void;
  validate?: (value: number) => void;
};

const view = (len: number, opts: ViewCoder) =>
  wrap({
    size: len,
    encodeStream: (w: TArg<Writer>, value: number) =>
      (w as _Writer).writeView(len, (view) => opts.write(view, value)),
    decodeStream: (r: TArg<Reader>) => (r as _Reader).readView(len, opts.read),
    validate: (value: number) => {
      if (typeof value !== 'number')
        throw new TypeError(`viewCoder: expected number, got ${typeof value}`);
      if (opts.validate) opts.validate(value);
      return value;
    },
  });

const intView = (len: number, signed: boolean, opts: ViewCoder) => {
  const bits = len * 8;
  const signBit = 2 ** (bits - 1);
  // Inlined checkBounds for integer
  const validateSigned = (value: number) => {
    if (!isNum(value)) throw new TypeError(`sintView: value is not safe integer: ${value}`);
    if (value < -signBit || value >= signBit) {
      throw new RangeError(
        `sintView: value out of bounds. Expected ${-signBit} <= ${value} < ${signBit}`
      );
    }
  };
  const maxVal = 2 ** bits;
  const validateUnsigned = (value: number) => {
    if (!isNum(value)) throw new TypeError(`uintView: value is not safe integer: ${value}`);
    if (0 > value || value >= maxVal) {
      throw new RangeError(`uintView: value out of bounds. Expected 0 <= ${value} < ${maxVal}`);
    }
  };
  return view(len, {
    write: opts.write,
    read: opts.read,
    validate: signed ? validateSigned : validateUnsigned,
  });
};

/** Unsigned 32-bit little-endian integer CoderType. */
export const U32LE: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(4, false, {
    read: (view, pos) => view.getUint32(pos, true),
    write: (view, value) => view.setUint32(0, value, true),
  })
);
/** Unsigned 32-bit big-endian integer CoderType. */
export const U32BE: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(4, false, {
    read: (view, pos) => view.getUint32(pos, false),
    write: (view, value) => view.setUint32(0, value, false),
  })
);
/** Signed 32-bit little-endian integer CoderType. */
export const I32LE: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(4, true, {
    read: (view, pos) => view.getInt32(pos, true),
    write: (view, value) => view.setInt32(0, value, true),
  })
);
/** Signed 32-bit big-endian integer CoderType. */
export const I32BE: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(4, true, {
    read: (view, pos) => view.getInt32(pos, false),
    write: (view, value) => view.setInt32(0, value, false),
  })
);
/** Unsigned 16-bit little-endian integer CoderType. */
export const U16LE: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(2, false, {
    read: (view, pos) => view.getUint16(pos, true),
    write: (view, value) => view.setUint16(0, value, true),
  })
);
/** Unsigned 16-bit big-endian integer CoderType. */
export const U16BE: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(2, false, {
    read: (view, pos) => view.getUint16(pos, false),
    write: (view, value) => view.setUint16(0, value, false),
  })
);
/** Signed 16-bit little-endian integer CoderType. */
export const I16LE: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(2, true, {
    read: (view, pos) => view.getInt16(pos, true),
    write: (view, value) => view.setInt16(0, value, true),
  })
);
/** Signed 16-bit big-endian integer CoderType. */
export const I16BE: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(2, true, {
    read: (view, pos) => view.getInt16(pos, false),
    write: (view, value) => view.setInt16(0, value, false),
  })
);
/** Unsigned 8-bit integer CoderType. */
export const U8: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(1, false, {
    read: (view, pos) => view.getUint8(pos),
    write: (view, value) => view.setUint8(0, value),
  })
);
/** Signed 8-bit integer CoderType. */
export const I8: CoderType<number> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ intView(1, true, {
    read: (view, pos) => view.getInt8(pos),
    write: (view, value) => view.setInt8(0, value),
  })
);

// Floats
const f32 = (le?: boolean) =>
  view(4, {
    read: (view, pos) => view.getFloat32(pos, le),
    write: (view, value) => view.setFloat32(0, value, le),
    validate: (value: number) => {
      if (Math.fround(value) !== value && !Number.isNaN(value))
        throw new Error(`f32: wrong value=${value}`);
    },
  });
const f64 = (le?: boolean) =>
  view(8, {
    read: (view, pos) => view.getFloat64(pos, le),
    write: (view, value) => view.setFloat64(0, value, le),
  });

/** 32-bit big-endian floating point CoderType ("binary32", IEEE 754-2008). */
export const F32BE: CoderType<number> = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ f32(false));
/** 32-bit little-endian floating point  CoderType ("binary32", IEEE 754-2008). */
export const F32LE: CoderType<number> = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ f32(true));
/** 64-bit big-endian floating point type ("binary64", IEEE 754-2008). */
export const F64BE: CoderType<number> = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ f64(false));
/** 64-bit little-endian floating point type ("binary64", IEEE 754-2008). */
export const F64LE: CoderType<number> = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ f64(true));
/** Boolean CoderType. */
export const bool: CoderType<boolean> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ wrap({
    size: 1,
    encodeStream: (w: TArg<Writer>, value: boolean) => w.byte(value ? 1 : 0),
    decodeStream: (r: TArg<Reader>): boolean => {
      const value = r.byte();
      if (value !== 0 && value !== 1) throw r.err(`bool: invalid value ${value}`);
      return value === 1;
    },
    validate: (value: boolean) => {
      if (typeof value !== 'boolean') throw new TypeError(`bool: invalid value ${value}`);
      return value;
    },
  })
);

/**
 * Bytes CoderType with a specified length and endianness.
 * The bytes can have:
 * - Dynamic size (prefixed with a length CoderType like U16BE)
 * - Fixed size (specified by a number)
 * - Unknown size (null, will parse until end of buffer)
 * - Zero-terminated (terminator can be any Uint8Array)
 * @param len - Length mode: CoderType for dynamic size, number for fixed size,
 * Uint8Array for terminator mode, or null to parse until end of buffer.
 * @param le - Whether to use little-endian byte order.
 * @returns CoderType representing the bytes.
 * @throws If the byte layout or terminator handling is invalid. {@link Error}
 * @throws On wrong byte-coder argument or value types. {@link TypeError}
 * @example
 * Use fixed-size, length-prefixed, or trailing byte arrays.
 * ```ts
 * import * as P from 'micro-packed';
 * const dynamicBytes = P.bytes(P.U16BE, false);
 * const fixedBytes = P.bytes(32, false); // Fixed size bytes
 * const unknownBytes = P.bytes(null, false); // Unknown size bytes, will parse until end of buffer
 * const zeroTerminatedBytes = P.bytes(Uint8Array.of(0), false); // Zero-terminated bytes
 * ```
 */
const createBytes = (len: Length, le = false): CoderType<Bytes> => {
  if (typeof le !== 'boolean') throw new TypeError(`bytes/le: expected boolean, got ${typeof le}`);
  const _length = lengthCoder(len);
  const _isb = isBytes(len);
  // Snapshot terminator bytes so the precomputed matcher and emitted terminator stay consistent.
  const terminator = _isb ? (Uint8Array.from(len as Bytes) as TRet<Bytes>) : undefined;
  const findTerminator = terminator && terminator.length ? createFindBytes(terminator) : undefined;
  return wrap({
    size: typeof len === 'number' ? len : undefined,
    encodeStream: (w: TArg<Writer>, value: TArg<Bytes>) => {
      if (!_isb) _length.encodeStream(w, value.length);
      w.bytes((le ? swapEndianness(value) : value) as TRet<Bytes>);
      if (terminator) w.bytes(terminator);
    },
    decodeStream: (r: TArg<Reader>): TRet<Bytes> => {
      let bytes: Bytes;
      if (terminator) {
        const tPos = r.find(terminator);
        // Position 0 is a valid empty payload before the terminator; only undefined means not found.
        if (tPos === undefined) throw r.err(`bytes: cannot find terminator`);
        bytes = r.bytes(tPos - r.pos);
        r.bytes(terminator.length);
      } else {
        bytes = r.bytes(len === null ? r.leftBytes : _length.decodeStream(r));
      }
      return (le ? swapEndianness(bytes) : bytes) as TRet<Bytes>;
    },
    validate: (value: TArg<Bytes>) => {
      if (!isBytes(value)) throw new TypeError(`bytes: invalid value ${value}`);
      if (findTerminator) {
        const data = le ? swapEndianness(value) : value;
        if (findTerminator(data) !== undefined) throw new Error('bytes: value contains terminator');
      }
      return value as Bytes;
    },
  });
};

export { createBytes as bytes, createHex as hex };

/**
 * Prefix-encoded value using a length prefix and an inner CoderType.
 * The prefix can have:
 * - Dynamic size (prefixed with a length CoderType like U16BE)
 * - Fixed size (specified by a number)
 * - Unknown size (null, will parse until end of buffer)
 * - Zero-terminated (terminator can be any Uint8Array)
 * @param len - Length mode: CoderType for dynamic size, number for fixed size,
 * Uint8Array for terminator mode, or null to parse until end of buffer.
 * @param inner - CoderType for the actual value to be prefix-encoded.
 * @returns CoderType representing the prefix-encoded value.
 * @throws If the prefix configuration or wrapped coding step is invalid. {@link Error}
 * @throws On wrong prefix-coder argument types. {@link TypeError}
 * @example
 * Prefix a payload with either a dynamic or fixed byte count.
 * ```ts
 * import * as P from 'micro-packed';
 * // Dynamic size prefix: prefixed with P.U16BE byte length.
 * const dynamicPrefix = P.prefix(P.U16BE, P.bytes(null));
 * // Fixed size prefix: always 10 bytes.
 * const fixedPrefix = P.prefix(10, P.bytes(null));
 * ```
 */
export function prefix<T>(len: Length, inner: CoderType<T>): CoderType<T> {
  if (!isCoder(inner)) throw new Error(`prefix: invalid inner value ${inner}`);
  return apply(createBytes(len), reverse(inner)) as CoderType<T>;
}

/**
 * String CoderType with a specified length and endianness.
 * The string can be:
 * - Dynamic size (prefixed with a length CoderType like U16BE)
 * - Fixed size (specified by a number)
 * - Unknown size (null, will parse until end of buffer)
 * - Zero-terminated (terminator can be any Uint8Array)
 * @param len - Length mode: CoderType for dynamic size, number for fixed size,
 * Uint8Array for terminator mode, or null to parse until end of buffer.
 * @param le - Whether to use little-endian byte order.
 * Note: UTF-8 has no endian variant; `le` reverses the encoded byte sequence
 * via the underlying byte coder.
 * @returns CoderType representing the string.
 * @throws If the underlying byte layout is invalid. {@link Error}
 * @throws On wrong string-coder argument or value types. {@link TypeError}
 * @example
 * Use fixed-size, length-prefixed, or trailing UTF-8 strings.
 * ```ts
 * import * as P from 'micro-packed';
 * // Dynamic string prefixed with P.U16BE string length.
 * const dynamicString = P.string(P.U16BE, false);
 * const fixedString = P.string(10, false);
 * // Unknown size string, parsed until end of buffer.
 * const unknownString = P.string(null, false);
 * const nullTerminatedString = P.cstring; // NUL-terminated string
 * const _cstring = P.string(Uint8Array.of(0)); // Same thing
 * ```
 */
export const string = (len: Length, le = false): CoderType<string> =>
  validate(apply(createBytes(len, le), utf8), (value) => {
    // TextEncoder/TextDecoder will fail on non-string, but we create more readable errors earlier
    if (typeof value !== 'string') throw new Error(`expected string, got ${typeof value}`);
    return value;
  });

/** NUL-terminated string CoderType. */
// Both factory calls need PURE markers so single-export treeshake bundles drop unused cstring.
export const cstring: CoderType<string> = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ string(NULL)
);

type HexOpts = { isLE?: boolean; with0x?: boolean };
/**
 * Hexadecimal string CoderType with a specified length, endianness, and optional 0x prefix.
 * @param len - Length mode: CoderType for dynamic size, number for fixed size,
 * Uint8Array for terminator mode, or null to parse until end of buffer.
 * @param options - Hex-specific endianness and prefix options. See {@link HexOpts}.
 * Use `isLE` to decode bytes as little-endian before converting to hex, and
 * `with0x` to add and require a `0x` prefix.
 * @returns CoderType representing the hexadecimal string.
 * @throws If the underlying byte layout or `0x` prefix handling is invalid. {@link Error}
 * @throws On wrong hex-coder argument or value types. {@link TypeError}
 * @example
 * Encode bytes as hex, optionally little-endian and with a `0x` prefix.
 * ```ts
 * import * as P from 'micro-packed';
 * // Hex string with 0x prefix and U16BE length.
 * const dynamicHex = P.hex(P.U16BE, {isLE: false, with0x: true});
 * // Fixed-length 32-byte hex string without 0x prefix.
 * const fixedHex = P.hex(32, {isLE: false, with0x: false});
 * ```
 */
const createHex = (
  len: Length,
  options: HexOpts = { isLE: false, with0x: false }
): CoderType<string> => {
  // HexOpts fields are optional independently; omitted fields keep the default behavior.
  const isLE = options.isLE === undefined ? false : options.isLE;
  const prefix = options.with0x === undefined ? false : options.with0x;
  if (typeof isLE !== 'boolean') throw new Error(`hex/isLE: expected boolean, got ${typeof isLE}`);
  if (typeof prefix !== 'boolean')
    throw new Error(`hex/with0x: expected boolean, got ${typeof prefix}`);
  let inner = apply(createBytes(len, isLE), baseHex);
  if (prefix) {
    inner = apply(inner, {
      encode: (value) => `0x${value}`,
      decode: (value) => {
        if (!value.startsWith('0x'))
          throw new Error('hex(with0x=true).encode input should start with 0x');
        return value.slice(2);
      },
    });
  }
  return inner;
};

/**
 * Applies a base coder to a CoderType.
 * @param inner - The inner CoderType.
 * @param base - The base coder to apply.
 * @returns CoderType representing the transformed value.
 * @throws On wrong inner-coder or base-coder argument types. {@link TypeError}
 * @example
 * Reuse a base coder on top of a binary bytes coder.
 * ```ts
 * import * as P from 'micro-packed';
 * import { hex as baseHex } from '@scure/base';
 * const hexCoder = P.apply(P.bytes(32), baseHex); // will decode bytes into a hex string
 * ```
 */
export function apply<T, F>(inner: CoderType<T>, base: BaseCoder<T, F>): CoderType<F> {
  // Constructor guards are documented TypeErrors and should name the rejected argument.
  if (!isCoder(inner)) throw new TypeError(`apply: invalid inner value ${inner}`);
  if (!isBaseCoder(base)) throw new TypeError(`apply: invalid base value ${base}`);
  return wrap({
    size: inner.size,
    encodeStream: (w: TArg<Writer>, value: F) => {
      let innerValue;
      try {
        innerValue = base.decode(value);
      } catch (e) {
        throw w.err('' + e);
      }
      return inner.encodeStream(w, innerValue);
    },
    decodeStream: (r: TArg<Reader>): F => {
      const innerValue = inner.decodeStream(r);
      try {
        return base.encode(innerValue);
      } catch (e) {
        throw r.err('' + e);
      }
    },
  });
}

/**
 * Lazy CoderType that is evaluated at runtime.
 * @param fn - A function that returns the CoderType.
 * @returns CoderType representing the lazy value.
 * @throws On wrong lazy-factory argument types. {@link TypeError}
 * @example
 * Define a recursive tree without referencing the coder before it exists.
 * ```ts
 * import * as P from 'micro-packed';
 * type Tree = { name: string; children: Tree[] };
 * const tree = P.struct({
 *   name: P.cstring,
 *   children: P.array(
 *     P.U16BE,
 *     P.lazy((): P.CoderType<Tree> => tree)
 *   ),
 * });
 * ```
 */
export function lazy<T>(fn: () => CoderType<T>): CoderType<T> {
  if (typeof fn !== 'function') throw new TypeError(`lazy: expected function, got ${typeof fn}`);
  return wrap({
    encodeStream: (w: TArg<Writer>, value: T) => fn().encodeStream(w, value),
    decodeStream: (r: TArg<Reader>): T => fn().decodeStream(r),
  });
}

/**
 * Flag CoderType that encodes/decodes a boolean value based on the presence of a marker.
 * @param flagValue - Marker value.
 * @param xor - Whether to invert the flag behavior.
 * @returns CoderType representing the flag value.
 * @throws On wrong flag argument or value types. {@link TypeError}
 * @throws If the marker is empty. {@link Error}
 * @example
 * Toggle a boolean based on whether a marker is present.
 * ```ts
 * import * as P from 'micro-packed';
 * // Encodes true as u8a([0x01, 0x02]), false as u8a([]).
 * const flag = P.flag(new Uint8Array([0x01, 0x02]));
 * // Encodes true as u8a([]), false as u8a([0x01, 0x02]).
 * const flagXor = P.flag(new Uint8Array([0x01, 0x02]), true);
 * const s = P.struct({ f: P.flag(new Uint8Array([0x0, 0x1])), f2: P.flagged('f', P.U32BE) });
 * ```
 */
export const flag = (flagValue: TArg<Bytes>, xor = false): CoderType<boolean | undefined> => {
  if (!isBytes(flagValue))
    throw new TypeError(`flag/flagValue: expected Uint8Array, got ${typeof flagValue}`);
  // Empty markers cannot distinguish presence from absence, so one boolean state is lost.
  if (flagValue.length === 0) throw new Error('flag/flagValue: empty marker');
  if (typeof xor !== 'boolean')
    throw new TypeError(`flag/xor: expected boolean, got ${typeof xor}`);
  return wrap({
    // Marker flags encode one state as empty, so encoded length depends on the boolean value.
    size: undefined,
    encodeStream: (w: TArg<Writer>, value: boolean | undefined) => {
      if (!!value !== xor) w.bytes(flagValue as TRet<Bytes>);
    },
    decodeStream: (r: TArg<Reader>): boolean | undefined => {
      let hasFlag = r.leftBytes >= flagValue.length;
      if (hasFlag) {
        hasFlag = equalBytes(r.bytes(flagValue.length, true), flagValue);
        // Found flag, advance cursor position
        if (hasFlag) r.bytes(flagValue.length);
      }
      return hasFlag !== xor; // hasFlag ^ xor
    },
    validate: (value: boolean | undefined) => {
      if (value !== undefined && typeof value !== 'boolean')
        throw new Error(`flag: expected boolean value or undefined, got ${typeof value}`);
      return value;
    },
  });
};

/**
 * Conditional CoderType that encodes/decodes a value only if a flag is present.
 * @param path - Path to the flag value or a CoderType for the flag.
 * @param inner - Inner CoderType for the value.
 * @param def - Optional default value to use if the flag is not present.
 * @returns CoderType representing the conditional value.
 * @throws On wrong flag-path or inner-coder argument types. {@link TypeError}
 * @example
 * Decode a field only when a sibling flag is present.
 * ```ts
 * import * as P from 'micro-packed';
 * const s = P.struct({
 *   f: P.flag(new Uint8Array([0x0, 0x1])),
 *   f2: P.flagged('f', P.U32BE)
 * });
 * ```
 *
 * @example
 * Supply a default when the sibling flag is missing.
 * ```ts
 * import * as P from 'micro-packed';
 * const s2 = P.struct({
 *   f: P.flag(new Uint8Array([0x0, 0x1])),
 *   f2: P.flagged('f', P.U32BE, 123)
 * });
 * ```
 */
export function flagged<T>(
  path: string | CoderType<boolean>,
  inner: CoderType<T>,
  def?: T
): CoderType<Option<T>> {
  if (typeof path !== 'string' && !isCoder(path))
    throw new TypeError(`flagged: wrong path=${path}`);
  if (!isCoder(inner)) throw new TypeError(`flagged: invalid inner value ${inner}`);
  const hasDef = def !== undefined;
  return wrap({
    encodeStream: (w: TArg<Writer>, value: Option<T>) => {
      if (typeof path === 'string') {
        if (Path.resolve((w as _Writer).stack, path)) inner.encodeStream(w, value);
        else if (hasDef) inner.encodeStream(w, def);
      } else {
        // Falsy values like 0 are valid payloads/defaults; only undefined means absent.
        const present = value !== undefined;
        path.encodeStream(w, present);
        if (present) inner.encodeStream(w, value);
        else if (hasDef) inner.encodeStream(w, def);
      }
    },
    decodeStream: (r: TArg<Reader>): Option<T> => {
      let hasFlag = false;
      if (typeof path === 'string') hasFlag = !!Path.resolve((r as _Reader).stack, path);
      else hasFlag = path.decodeStream(r);
      // If there is a flag -- decode and return value
      if (hasFlag) return inner.decodeStream(r);
      else if (hasDef) inner.decodeStream(r);
      return;
    },
  });
}
/**
 * Optional CoderType that encodes/decodes a value based on a flag.
 * @param flag - CoderType for the flag value.
 * @param inner - Inner CoderType for the value.
 * @param def - Optional default value to use if the flag is not present.
 * @returns CoderType representing the optional value.
 * @throws On wrong flag-coder or inner-coder argument types. {@link TypeError}
 * @example
 * Decode a value only when a marker flag is present.
 * ```ts
 * import * as P from 'micro-packed';
 * const optional = P.optional(P.flag(new Uint8Array([0x0, 0x1])), P.U32BE);
 * ```
 *
 * @example
 * Provide a fallback value when the marker flag is absent.
 * ```ts
 * import * as P from 'micro-packed';
 * const optionalWithDefault = P.optional(P.flag(new Uint8Array([0x0, 0x1])), P.U32BE, 123);
 * ```
 */
export function optional<T>(
  flag: CoderType<boolean>,
  inner: CoderType<T>,
  def?: T
): CoderType<Option<T>> {
  if (!isCoder(flag) || !isCoder(inner))
    throw new TypeError(`optional: invalid flag or inner value flag=${flag} inner=${inner}`);
  const hasDef = def !== undefined;
  return wrap({
    size:
      hasDef && flag.size !== undefined && inner.size !== undefined
        ? flag.size + inner.size
        : undefined,
    encodeStream: (w: TArg<Writer>, value: Option<T>) => {
      // Falsy values like 0 are valid payloads/defaults; only undefined means absent.
      const present = value !== undefined;
      flag.encodeStream(w, present);
      if (present) inner.encodeStream(w, value);
      else if (hasDef) inner.encodeStream(w, def);
    },
    decodeStream: (r: TArg<Reader>): Option<T> => {
      if (flag.decodeStream(r)) return inner.decodeStream(r);
      else if (hasDef) inner.decodeStream(r);
      return;
    },
  });
}
/**
 * Magic value CoderType that encodes/decodes a constant value.
 * This can be used to check for a specific magic value or byte sequence
 * at the beginning of a data structure.
 * @param inner - Inner CoderType for the value.
 * @param constant - Constant value.
 * @param check - Whether to check the decoded value against the constant.
 * @returns CoderType representing the magic value.
 * @throws On wrong magic-coder argument types. {@link TypeError}
 * @example
 * Require a specific encoded value at this position in the stream.
 * ```ts
 * import * as P from 'micro-packed';
 * const magicU8 = P.magic(P.U8, 0x42);
 * ```
 */
export function magic<T>(inner: CoderType<T>, constant: T, check = true): CoderType<undefined> {
  if (!isCoder(inner)) throw new TypeError(`magic: invalid inner value ${inner}`);
  if (typeof check !== 'boolean')
    throw new TypeError(`magic: expected boolean, got ${typeof check}`);
  return wrap({
    size: inner.size,
    encodeStream: (w: TArg<Writer>, _value: undefined) => inner.encodeStream(w, constant),
    decodeStream: (r: TArg<Reader>): undefined => {
      const value = inner.decodeStream(r);
      // check=false still consumes the encoded field but intentionally skips constant comparison.
      // Generic object equality would need deep-equal semantics, and decoded structs are fresh
      // objects. Skip only when both sides are non-byte objects; mismatched primitive/object or
      // byte/object pairs are still comparable and should reject.
      const valueObj = value !== null && typeof value === 'object' && !isBytes(value);
      const constantObj = constant !== null && typeof constant === 'object' && !isBytes(constant);
      const canCompare = !valueObj || !constantObj;
      if (check && canCompare && !equal(value, constant)) {
        throw r.err(`magic: invalid value: ${value} !== ${constant}`);
      }
      return;
    },
    validate: (value: undefined) => {
      if (value !== undefined) throw new Error(`magic: wrong value=${typeof value}`);
      return value;
    },
  });
}
/**
 * Magic bytes CoderType that encodes/decodes a constant byte array or string.
 * @param constant - Constant byte array or string.
 * @returns CoderType representing the magic bytes.
 * @throws If the constant check fails or the wrapped coder rejects the bytes. {@link Error}
 * @throws On wrong magic-bytes argument types. {@link TypeError}
 * Note: Uint8Array constants are retained by reference; do not mutate them
 * after constructing the coder.
 * @example
 * Match a fixed byte or string marker without producing a value.
 * ```ts
 * import * as P from 'micro-packed';
 * const magicBytes = P.magicBytes('MAGIC');
 * ```
 */
export const magicBytes = (constant: TArg<Bytes | string>): CoderType<undefined> => {
  if (typeof constant !== 'string' && !isBytes(constant))
    throw new TypeError(`magicBytes: expected Uint8Array or string, got ${typeof constant}`);
  const c = typeof constant === 'string' ? utf8.decode(constant) : constant;
  return magic(createBytes(c.length), c);
};

/**
 * Creates a CoderType for a constant value. The function enforces this value during encoding,
 * ensuring it matches the provided constant. During decoding, it always returns the constant value.
 * The actual value is not written to or read from any byte stream; it's used only for validation.
 *
 * @param c - Constant value.
 * @returns CoderType representing the constant value.
 * @throws On wrong constant values passed during encoding. {@link TypeError}
 * Note: object constants are compared and returned by reference.
 * @example
 * Hide an always-constant field behind a regular coder.
 * ```ts
 * import * as P from 'micro-packed';
 * const constantU8 = P.constant(123);
 * ```
 */
export function constant<T>(c: T): CoderType<T> {
  return wrap({
    // Constants validate state but do not consume bytes, so fixed-size compositions can stay fixed.
    size: 0,
    encodeStream: (_w: TArg<Writer>, value: T) => {
      if (value !== c) throw new TypeError(`constant: invalid value ${value} (exp: ${c})`);
    },
    decodeStream: (_r: TArg<Reader>): T => c,
  });
}

function sizeof(fields: CoderType<any>[]): Option<number> {
  let size: Option<number> = 0;
  for (const f of fields) {
    if (f.size === undefined) return;
    if (!isNum(f.size)) throw new Error(`sizeof: wrong element size=${size}`);
    size += f.size;
  }
  return size;
}
/**
 * Structure of composable primitives (C/Rust struct)
 * @param fields - Object mapping field names to CoderTypes.
 * @returns CoderType representing the structure.
 * @throws If the structure definition or encoded struct value is invalid. {@link Error}
 * @throws On wrong structure argument types. {@link TypeError}
 * Note: the fields object is retained by reference; mutating it after
 * construction can change encoding
 * while leaving fixed-size metadata unchanged.
 * @example
 * Combine named fields into a single structured coder.
 * ```ts
 * import * as P from 'micro-packed';
 * const myStruct = P.struct({
 *   id: P.U32BE,
 *   name: P.string(P.U8),
 *   nested: P.struct({
 *     flag: P.bool,
 *     value: P.I16LE
 *   })
 * });
 * ```
 */
export function struct<T extends Record<string, any>>(
  fields: StructRecord<T>
): CoderType<StructInput<T>> {
  if (!isPlainObject(fields)) throw new TypeError(`struct: expected plain object, got ${fields}`);
  // Size metadata must use the same enumerable field set as encode/decode; Object.values() skips
  // inherited fields that for...in will still encode.
  const coders: CoderType<any>[] = [];
  for (const name in fields) {
    // String paths use '/' as the nested-field separator, so accepting it in struct keys makes
    // diagnostics and Path.resolve() lookups ambiguous.
    validateFieldName(name, 'struct: field');
    if (!isCoder(fields[name])) throw new TypeError(`struct: field ${name} is not CoderType`);
    coders.push(fields[name]);
  }
  return wrap({
    size: sizeof(coders),
    encodeStream: (w: TArg<Writer>, value: StructInput<T>) => {
      (w as _Writer).pushObj(value, (fieldFn) => {
        for (const name in fields)
          fieldFn(name, () => fields[name].encodeStream(w, (value as T)[name]));
      });
    },
    decodeStream: (r: TArg<Reader>): StructInput<T> => {
      const res: Partial<T> = {};
      (r as _Reader).pushObj(res, (fieldFn) => {
        for (const name in fields) fieldFn(name, () => (res[name] = fields[name].decodeStream(r)));
      });
      return res as T;
    },
    validate: (value: StructInput<T>) => {
      if (typeof value !== 'object' || value === null)
        throw new Error(`struct: invalid value ${value}`);
      return value;
    },
  });
}
/**
 * Tuple (unnamed structure) of CoderTypes. Same as struct but with unnamed fields.
 * @param fields - Array of CoderTypes.
 * @returns CoderType representing the tuple.
 * @throws If the tuple definition or encoded tuple value is invalid. {@link Error}
 * @throws On wrong tuple argument types. {@link TypeError}
 * Note: unbounded coders such as `array(null, ...)` should be last or length-prefixed; otherwise
 * they can consume bytes intended for later fields.
 * Note: the fields array is retained by reference; mutating it after construction can change encoding
 * while leaving fixed-size metadata unchanged.
 * @example
 * Combine several coders into an ordered fixed-length tuple.
 * ```ts
 * import * as P from 'micro-packed';
 * const myTuple = P.tuple([P.U8, P.U16LE, P.string(P.U8)]);
 * ```
 */
export function tuple<
  T extends ArrLike<CoderType<any>>,
  O = Writable<{ [K in keyof T]: UnwrapCoder<T[K]> }>,
>(fields: T): CoderType<O> {
  if (!Array.isArray(fields))
    throw new TypeError(`Packed.Tuple: got ${typeof fields} instead of array`);
  for (let i = 0; i < fields.length; i++) {
    if (!isCoder(fields[i])) throw new TypeError(`tuple: field ${i} is not CoderType`);
  }
  return wrap({
    size: sizeof(fields),
    encodeStream: (w: TArg<Writer>, value: O) => {
      // TODO: fix types
      if (!Array.isArray(value)) throw w.err(`tuple: invalid value ${value}`);
      (w as _Writer).pushObj(value, (fieldFn) => {
        for (let i = 0; i < fields.length; i++)
          fieldFn(`${i}`, () => fields[i].encodeStream(w, value[i]));
      });
    },
    decodeStream: (r: TArg<Reader>): O => {
      const res: any = [];
      (r as _Reader).pushObj(res, (fieldFn) => {
        for (let i = 0; i < fields.length; i++)
          fieldFn(`${i}`, () => res.push(fields[i].decodeStream(r)));
      });
      return res;
    },
    validate: (value: O) => {
      if (!Array.isArray(value)) throw new Error(`tuple: invalid value ${value}`);
      if (value.length !== fields.length)
        throw new Error(`tuple: wrong length=${value.length}, expected ${fields.length}`);
      return value;
    },
  });
}

/**
 * Array of items (inner type) with a specified length.
 * @param len - Length mode: CoderType for dynamic size, number for fixed size,
 * Uint8Array for terminator mode, or null to parse until end of buffer.
 * @param inner - CoderType for encoding/decoding each array item.
 * @returns CoderType representing the array.
 * @throws If the array definition or encoded array elements are invalid. {@link Error}
 * @throws On wrong array-coder argument types. {@link TypeError}
 * Note: Uint8Array terminators are retained by reference; do not mutate them
 * after constructing the coder.
 * @example
 * Build dynamic, fixed-size, and trailing arrays from one item coder.
 * ```ts
 * import * as P from 'micro-packed';
 * const child = P.U8;
 * // Dynamic array prefixed with P.U16BE array length.
 * const a1 = P.array(P.U16BE, child);
 * const a2 = P.array(4, child); // Fixed size array
 * // Unknown size array, parsed until end of buffer.
 * const a3 = P.array(null, child);
 * // Zero-terminated array; terminator can be any buffer.
 * const a4 = P.array(Uint8Array.of(0), child);
 * ```
 */
export function array<T>(len: Length, inner: CoderType<T>): CoderType<T[]> {
  // Constructor argument validation uses TypeError.
  // Array data failures still come from reader/writer errors.
  if (!isCoder(inner)) throw new TypeError(`array: invalid inner value ${inner}`);
  // By construction length is inside array (otherwise there will be various incorrect stack states)
  // But forcing users always write '..' seems like bad idea. Also, breaking change.
  const _length = lengthCoder(typeof len === 'string' ? `../${len}` : len);
  // Unbounded arrays must make cursor progress; zero-size children would loop forever.
  if (len === null && inner.size === 0)
    throw new Error('array: null length cannot use zero-size inner');
  return wrap({
    // `size: 0` is a valid fixed-size hint and must compose through arrays/tuples/structs.
    size: typeof len === 'number' && inner.size !== undefined ? len * inner.size : undefined,
    encodeStream: (w: TArg<Writer>, value: T[]) => {
      const _w = w as _Writer;
      _w.pushObj(value, (fieldFn) => {
        if (!isBytes(len)) _length.encodeStream(w, value.length);
        for (let i = 0; i < value.length; i++) {
          fieldFn(`${i}`, () => {
            const elm = value[i];
            const startPos = (w as _Writer).pos;
            inner.encodeStream(w, elm);
            if (isBytes(len)) {
              // Terminator is bigger than elm size, so skip
              if (len.length > _w.pos - startPos) return;
              const data = _w.finish(false).subarray(startPos, _w.pos);
              // There is still possible case when multiple elements create terminator,
              // but it is hard to catch here, will be very slow
              if (equalBytes(data.subarray(0, len.length), len))
                throw _w.err(
                  `array: inner element encoding same as separator. elm=${elm} data=${data}`
                );
            }
          });
        }
      });
      if (isBytes(len)) w.bytes(len as TRet<Bytes>);
    },
    decodeStream: (r: TArg<Reader>): T[] => {
      const res: T[] = [];
      const _r = r as _Reader;
      _r.pushObj(res, (fieldFn) => {
        if (len === null) {
          for (let i = 0; !r.isEnd(); i++) {
            fieldFn(`${i}`, () => {
              // Dynamic coders can advertise unknown size while consuming zero bits; unbounded
              // loops must check actual progress instead of trusting size metadata.
              const progress = _r.progress();
              res.push(inner.decodeStream(r));
              if (_r.progress() === progress)
                throw r.err('array: inner decoder did not consume input');
            });
            if (inner.size && r.leftBytes < inner.size) break;
          }
        } else if (isBytes(len)) {
          for (let i = 0; ; i++) {
            if (equalBytes(r.bytes(len.length, true), len)) {
              // Advance cursor position if terminator found
              r.bytes(len.length);
              break;
            }
            fieldFn(`${i}`, () => {
              const progress = _r.progress();
              res.push(inner.decodeStream(r));
              if (_r.progress() === progress)
                throw r.err('array: inner decoder did not consume input');
            });
          }
        } else {
          let length: number;
          fieldFn('arrayLen', () => (length = _length.decodeStream(r)));
          for (let i = 0; i < length!; i++) fieldFn(`${i}`, () => res.push(inner.decodeStream(r)));
        }
      });
      return res;
    },
    validate: (value: T[]) => {
      if (!Array.isArray(value)) throw new Error(`array: invalid value ${value}`);
      return value;
    },
  });
}
/**
 * Mapping between encoded values and string representations.
 * @param inner - CoderType for encoded values.
 * @param variants - Object mapping string representations to encoded values.
 * @returns CoderType representing the mapping.
 * @throws If mapping variants are invalid or raw variant values are duplicate. {@link Error}
 * @throws On wrong mapping argument types. {@link TypeError}
 * Note: variants are copied into lookup maps at construction; mutating the
 * original object later does not update the coder.
 * Note: construction does not run the inner coder. Path-dependent coders need
 * encode/decode stack context that does not exist at construction, so selected
 * variant values are validated by the inner coder only when encoded or decoded.
 * @example
 * Map encoded numbers to a small set of string labels.
 * ```ts
 * import * as P from 'micro-packed';
 * const numberMap = P.map(P.U8, {
 *   'one': 1,
 *   'two': 2,
 *   'three': 3
 * });
 *
 * const byteMap = P.map(P.hex(2), {
 *   'ab': '6162',
 *   'cd': '6364'
 * });
 * ```
 */
export function map<T>(inner: CoderType<T>, variants: Record<string, T>): CoderType<string> {
  if (!isCoder(inner)) throw new TypeError(`map: invalid inner value ${inner}`);
  if (!isPlainObject(variants)) throw new TypeError(`map: variants should be plain object`);
  const variantValues = new Map<string, T>();
  const variantNames: Map<T, string> = new Map();
  const primitiveTypes = ['string', 'number', 'bigint', 'boolean', 'undefined', 'null'];
  for (const k in variants) {
    const value = variants[k];
    // Object values such as Uint8Array are not stable reverse-map keys; wrap bytes in a primitive
    // coder first, e.g. apply(bytes(...), hex).
    if (!primitiveTypes.includes(value === null ? 'null' : typeof value))
      throw new TypeError(`map: variant ${k} should be primitive`);
    if (variantNames.has(value))
      throw new Error(`map: duplicate value for ${k} and ${variantNames.get(value)}`);
    variantValues.set(k, value);
    variantNames.set(value, k);
  }
  return wrap({
    size: inner.size,
    encodeStream: (w: TArg<Writer>, value: string) => {
      if (!variantValues.has(value)) throw w.err(`Map: unknown variant: ${value}`);
      inner.encodeStream(w, variantValues.get(value)!);
    },
    decodeStream: (r: TArg<Reader>): string => {
      const variant = inner.decodeStream(r);
      const name = variantNames.get(variant);
      if (name === undefined)
        throw r.err(`Enum: unknown value: ${variant} ${Array.from(variantNames.keys())}`);
      return name;
    },
    validate: (value: string) => {
      if (typeof value !== 'string') throw new Error(`map: invalid value ${value}`);
      if (!variantValues.has(value)) throw new Error(`Map: unknown variant: ${value}`);
      return value;
    },
  });
}
/**
 * Tagged union of CoderTypes, where the tag value determines which CoderType to use.
 * The decoded value will have the structure `\{ TAG: number, data: ... \}`.
 * @param tag - CoderType for the tag value.
 * @param variants - Object mapping tag values to CoderTypes.
 * @returns CoderType representing the tagged union.
 * @throws On wrong tag-coder or variant-map argument types. {@link TypeError}
 * Note: variants are copied into a lookup map at construction; mutating the
 * original object later does not update the coder.
 * Note: construction does not run the tag coder. Path-dependent tag coders need
 * encode/decode stack context that does not exist at construction, so callers
 * are responsible for providing tag keys that the tag coder can encode/decode.
 * @example
 * Switch between payload coders based on a leading tag byte.
 * ```ts
 * import * as P from 'micro-packed';
 * const taggedUnion = P.tag(P.U8, {
 *   0x01: P.array(P.U16LE, P.U8),
 *   0x02: P.string(P.U8),
 *   0x03: P.U32BE
 * });
 *
 * const encoded = taggedUnion.encode({ TAG: 0x01, data: [1, 2] });
 * const decoded = taggedUnion.decode(encoded);
 * ```
 */
export function tag<
  T extends Values<{
    [P in keyof Variants]: { TAG: P; data: UnwrapCoder<Variants[P]> };
  }>,
  TagValue extends string | number,
  Variants extends Record<TagValue, CoderType<any>>,
>(tag: CoderType<TagValue>, variants: Variants): CoderType<T> {
  if (!isCoder(tag)) throw new TypeError(`tag: invalid tag value ${tag}`);
  if (!isPlainObject(variants)) throw new TypeError(`tag: variants should be plain object`);
  const variantCoders = new Map<TagValue, CoderType<any>>();
  for (const name in variants) {
    if (!isCoder(variants[name])) throw new TypeError(`tag: variant ${name} is not CoderType`);
    variantCoders.set(name as any, variants[name]);
    const num = Number(name);
    // Object keys are strings; mirror canonical integer keys as numbers so numeric tag coders still
    // decode to the same arm without running the tag coder at construction.
    if (isNum(num) && String(num) === name) variantCoders.set(num as any, variants[name]);
  }
  let size: number | undefined;
  let dataSize: number | undefined;
  let dynamic = tag.size === undefined;
  // Tagged unions have a fixed size only when every arm contributes the same fixed payload size.
  for (const name in variants) {
    const cur = variants[name].size;
    if (cur === undefined || (dataSize !== undefined && cur !== dataSize)) dynamic = true;
    dataSize = cur;
  }
  if (!dynamic && dataSize !== undefined) size = tag.size! + dataSize;
  return wrap({
    size,
    encodeStream: (w: TArg<Writer>, value: T) => {
      const { TAG, data } = value;
      const dataType = variantCoders.get(TAG as any);
      if (!dataType) throw w.err(`Tag: invalid tag ${TAG.toString()}`);
      tag.encodeStream(w, TAG as any);
      dataType.encodeStream(w, data);
    },
    decodeStream: (r: TArg<Reader>): T => {
      const TAG = tag.decodeStream(r);
      const dataType = variantCoders.get(TAG);
      if (!dataType) throw r.err(`Tag: invalid tag ${TAG}`);
      return { TAG, data: dataType.decodeStream(r) } as any;
    },
    validate: (value: T) => {
      const { TAG } = value;
      const dataType = variantCoders.get(TAG as any);
      if (!dataType) throw new Error(`Tag: invalid tag ${TAG.toString()}`);
      return value;
    },
  });
}

/**
 * Mapping between encoded values, string representations, and CoderTypes using a tag CoderType.
 * @param tagCoder - CoderType for the tag value.
 * @param variants - Object mapping string representations to [tag value, CoderType] pairs.
 * @returns CoderType representing the mapping.
 * @throws If the mapped-tag table is invalid, raw tag values are duplicate,
 * or the selected variant is invalid. {@link Error}
 * @throws On wrong tag-coder or variant-map argument types. {@link TypeError}
 * Note: construction does not run the tag coder. Path-dependent tag coders need
 * encode/decode stack context that does not exist at construction, so callers
 * are responsible for providing tag values that the tag coder can encode/decode.
 * Note: variant pairs are copied at construction; mutating the original variants
 * object or pair arrays later does not update the coder.
 * @example
 * Use string tags in TypeScript while encoding them as compact numeric tags.
 * ```ts
 * import * as P from 'micro-packed';
 * type Value =
 *   | { TAG: 'uint'; data: number }
 *   | { TAG: 'array'; data: Value[] };
 * const value: P.CoderType<Value> = P.mappedTag(P.U8, {
 *   uint: [0, P.U8],
 *   array: [1, P.array(P.U8, P.lazy(() => value))],
 * });
 * value.encode({ TAG: 'array', data: [{ TAG: 'uint', data: 5 }] });
 * ```
 */
export function mappedTag<
  T extends Values<{
    [P in keyof Variants]: { TAG: P; data: UnwrapCoder<Variants[P][1]> };
  }>,
  TagValue extends string | number,
  Variants extends Record<string, [TagValue, CoderType<any>]>,
>(tagCoder: CoderType<TagValue>, variants: Variants): CoderType<T> {
  if (!isCoder(tagCoder)) throw new TypeError(`mappedTag: invalid tag value ${tagCoder}`);
  if (!isPlainObject(variants)) throw new TypeError(`mappedTag: variants should be plain object`);
  const mapValue = new Map<string, TagValue>();
  const tagValue = new Map<string, CoderType<any>>();
  for (const key in variants) {
    const v = variants[key];
    mapValue.set(key, v[0]);
    tagValue.set(key, v[1]);
  }
  // Object.fromEntries creates "__proto__" as an own data field; assignment to plain {}
  // would instead mutate the temporary object's prototype before map()/tag() see it.
  const mapped = Object.fromEntries(mapValue) as Record<string, TagValue>;
  const tagged = Object.fromEntries(tagValue) as Record<string, CoderType<any>>;
  return tag(map(tagCoder, mapped), tagged) as any as CoderType<T>;
}

/**
 * Bitset of boolean values with optional padding.
 * @param names - An array of string names for the bitset values.
 * @param pad - Whether to pad the bitset to a multiple of 8 bits.
 * @param strict - Whether to reject duplicate names and non-zero padding bits.
 * @returns CoderType representing the bitset.
 * @typeParam Names - Bit names preserved in the returned record.
 * @throws If the bitset definition or encoded bitset values are invalid. {@link Error}
 * @throws On wrong bitset argument types. {@link TypeError}
 * Note: bits follow `names` order and are written most-significant-bit first
 * within each byte; non-byte-aligned `pad=false` bitsets must be composed with
 * more bit-level coders.
 * Note: strict mode is opt-in for legacy compatibility with callers that used
 * repeated reserved names or accept non-zero padding bits.
 * Note: the names array is retained by reference; mutating it after construction
 * changes encoding and decoding.
 * @example
 * Pack several named booleans into a compact bitset.
 * ```ts
 * import * as P from 'micro-packed';
 * const myBitset = P.bitset(['flag1', 'flag2', 'flag3', 'flag4'], true);
 * ```
 */
export function bitset<Names extends readonly string[]>(
  names: Names,
  pad = false,
  strict = false
): CoderType<Record<Names[number], boolean>> {
  if (typeof pad !== 'boolean')
    throw new TypeError(`bitset/pad: expected boolean, got ${typeof pad}`);
  if (typeof strict !== 'boolean')
    throw new TypeError(`bitset/strict: expected boolean, got ${typeof strict}`);
  if (!Array.isArray(names)) throw new TypeError('bitset/names: expected array');
  const nameSet = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string') throw new TypeError('bitset/names: expected array of strings');
    if (strict && nameSet.has(name)) throw new Error(`bitset/names: duplicate name ${name}`);
    validateFieldName(name, 'bitset/names: name');
    nameSet.add(name);
  }
  return wrap({
    // Padded and byte-aligned bitsets consume whole bytes, so fixed-size compositions can stay fixed.
    size: pad || names.length % 8 === 0 ? Math.ceil(names.length / 8) : undefined,
    encodeStream: (w: TArg<Writer>, value: Record<Names[number], boolean>) => {
      const vals = value as Record<string, boolean>;
      for (let i = 0; i < names.length; i++)
        w.bits(hasOwn(vals, names[i]) ? +vals[names[i]] : 0, 1);
      if (pad && names.length % 8) w.bits(0, 8 - (names.length % 8));
    },
    decodeStream: (r: TArg<Reader>): Record<Names[number], boolean> => {
      const out: Record<string, boolean> = {};
      for (let i = 0; i < names.length; i++) out[names[i]] = !!r.bits(1);
      if (pad && names.length % 8) {
        const padding = r.bits(8 - (names.length % 8));
        // Encoders always write zero padding; strict mode rejects alternate encodings with hidden set bits.
        if (strict && padding) throw r.err('bitset: non-zero padding bits');
      }
      return out;
    },
    validate: (value: Record<Names[number], boolean>) => {
      if (!isPlainObject(value)) throw new Error(`bitset: invalid value ${value}`);
      const vals = value as Record<string, unknown>;
      for (const name of names) {
        if (!hasOwn(vals, name)) continue;
        if (typeof vals[name] !== 'boolean')
          throw new Error(`bitset: expected boolean for ${name}`);
      }
      return value;
    },
  });
}
/**
 * Padding function which always returns zero.
 * @param i - Zero-based padding byte index.
 * @returns Always returns `0`.
 * @example
 * Use the default zero padding helper with padLeft/padRight.
 * ```ts
 * import { U16BE, ZeroPad, padLeft } from 'micro-packed';
 * padLeft(4, U16BE, ZeroPad);
 * ```
 */
export const ZeroPad: PadFn = (_) => 0;

function padLength(blockSize: number, len: number): number {
  // Padding counts bytes already written/read; negative lengths invert modulo math.
  if (!isNum(len) || len < 0) throw new Error(`padLength: wrong length=${len}`);
  if (len % blockSize === 0) return 0;
  return blockSize - (len % blockSize);
}
/**
 * Pads a CoderType with a specified block size and padding function on the left side.
 * @param blockSize - Block size for padding (positive safe integer).
 * @param inner - Inner CoderType to pad.
 * @param padFn - Padding function to use. If not provided, zero padding is used.
 * @returns CoderType representing the padded value.
 * Note: decode skips the computed left-padding bytes without validating values;
 * `padFn` affects encoding only.
 * @throws If the padding configuration or wrapped coder is invalid. {@link Error}
 * @throws On wrong padding argument types. {@link TypeError}
 * @example
 * Left-pad a value to the next block boundary.
 * ```ts
 * import * as P from 'micro-packed';
 * const paddedU32BE = P.padLeft(4, P.U32BE);
 *
 * const paddedBytes = P.padLeft(16, P.bytes(8), (i) => i + 1);
 * ```
 */
export function padLeft<T>(
  blockSize: number,
  inner: CoderType<T>,
  padFn: Option<PadFn>
): CoderType<T> {
  if (!isNum(blockSize) || blockSize <= 0)
    throw new TypeError(`padLeft: wrong blockSize=${blockSize}`);
  if (!isCoder(inner)) throw new TypeError(`padLeft: invalid inner value ${inner}`);
  if (padFn !== undefined && typeof padFn !== 'function')
    throw new TypeError(`padLeft: wrong padFn=${typeof padFn}`);
  const _padFn = padFn || ZeroPad;
  // `size: 0` is fixed-size and should pad as zero bytes; only undefined means dynamic.
  if (inner.size === undefined) throw new Error('padLeft cannot have dynamic size');
  const size = inner.size;
  return wrap({
    size: size + padLength(blockSize, size),
    encodeStream: (w: TArg<Writer>, value: T) => {
      const padBytes = padLength(blockSize, size);
      for (let i = 0; i < padBytes; i++) w.byte(_padFn(i));
      inner.encodeStream(w, value);
    },
    decodeStream: (r: TArg<Reader>): T => {
      r.bytes(padLength(blockSize, size));
      return inner.decodeStream(r);
    },
  });
}
/**
 * Pads a CoderType with a specified block size and padding function on the right side.
 * @param blockSize - Block size for padding (positive safe integer).
 * @param inner - Inner CoderType to pad.
 * @param padFn - Padding function to use. If not provided, zero padding is used.
 * @returns CoderType representing the padded value.
 * Note: decode skips the computed right-padding bytes without validating values;
 * `padFn` affects encoding only.
 * @throws If the padding configuration or wrapped coder is invalid. {@link Error}
 * @throws On wrong padding argument types. {@link TypeError}
 * @example
 * Right-pad a value to the next block boundary.
 * ```ts
 * import * as P from 'micro-packed';
 * const paddedU16BE = P.padRight(2, P.U16BE);
 *
 * const paddedBytes = P.padRight(8, P.bytes(null), (i) => i + 1);
 * ```
 */
export function padRight<T>(
  blockSize: number,
  inner: CoderType<T>,
  padFn: Option<PadFn>
): CoderType<T> {
  if (!isCoder(inner)) throw new TypeError(`padRight: invalid inner value ${inner}`);
  if (!isNum(blockSize) || blockSize <= 0)
    throw new TypeError(`padRight: wrong blockSize=${blockSize}`);
  if (padFn !== undefined && typeof padFn !== 'function')
    throw new TypeError(`padRight: wrong padFn=${typeof padFn}`);
  const _padFn = padFn || ZeroPad;
  const size = inner.size;
  return wrap({
    // `size: 0` is fixed-size and should pad as zero bytes; only undefined means dynamic.
    size: size === undefined ? undefined : size + padLength(blockSize, size),
    encodeStream: (w: TArg<Writer>, value: T) => {
      const _w = w as _Writer;
      const pos = _w.pos;
      inner.encodeStream(w, value);
      const padBytes = padLength(blockSize, _w.pos - pos);
      for (let i = 0; i < padBytes; i++) w.byte(_padFn(i));
    },
    decodeStream: (r: TArg<Reader>): T => {
      const start = r.pos;
      const res = inner.decodeStream(r);
      r.bytes(padLength(blockSize, r.pos - start));
      return res;
    },
  });
}
/**
 * Pointer to a value using a pointer CoderType and an inner CoderType.
 * Pointers are scoped, and the next pointer in the dereference chain is offset by the previous one.
 * By default (if no 'allowMultipleReads' in ReaderOpts is set) is safe, since
 * same region of memory cannot be read multiple times.
 * @param ptr - CoderType for the pointer value.
 * @param inner - CoderType for encoding/decoding the pointed value.
 * @param sized - Whether the in-place pointer slot should report a fixed size.
 * @returns CoderType representing the pointer to the value.
 * @throws If the pointer configuration or pointed value decoding is invalid. {@link Error}
 * @throws On wrong pointer-coder argument types. {@link TypeError}
 * @example
 * Jump to a pointed value and decode it with another coder.
 * ```ts
 * import * as P from 'micro-packed';
 * const pointerToU8 = P.pointer(P.U16BE, P.U8); // Pointer to a single U8 value
 * ```
 */
export function pointer<T>(
  ptr: CoderType<number>,
  inner: CoderType<T>,
  sized = false
): CoderType<T> {
  if (!isCoder(ptr)) throw new TypeError(`pointer: invalid ptr value ${ptr}`);
  if (!isCoder(inner)) throw new TypeError(`pointer: invalid inner value ${inner}`);
  if (typeof sized !== 'boolean')
    throw new TypeError(`pointer/sized: expected boolean, got ${typeof sized}`);
  if (!ptr.size) throw new Error('unsized pointer');
  return wrap({
    // Pointer payloads are appended by Writer.finish().
    // Size only describes the in-place pointer slot
    // so surrounding structs/arrays can lay out the fixed section before pointed data.
    size: sized ? ptr.size : undefined,
    encodeStream: (w: TArg<Writer>, value: T) => {
      const _w = w as _Writer;
      const start = _w.pos;
      ptr.encodeStream(w, 0);
      _w.ptrs.push({ pos: start, ptr, buffer: inner.encode(value) });
    },
    decodeStream: (r: TArg<Reader>): T => {
      const ptrVal = ptr.decodeStream(r);
      (r as _Reader)._enablePointers();
      return inner.decodeStream(r.offsetReader(ptrVal));
    },
  });
}

// Internal methods for test purposes only.
// Note: _TEST exposes live internal namespaces by reference for tests.
// Mutating them changes runtime behavior.
export const _TEST: {
  _bitset: {
    BITS: number;
    FULL_MASK: number;
    len: (len: number) => number;
    create: (len: number) => Uint32Array;
    clean: (bs: Uint32Array) => Uint32Array;
    debug: (bs: Uint32Array) => string[];
    checkLen: (bs: Uint32Array, len: number) => void;
    chunkLen: (bsLen: number, pos: number, len: number) => void;
    set: (bs: Uint32Array, chunk: number, value: number, allowRewrite?: boolean) => boolean;
    pos: (
      pos: number,
      i: number
    ) => {
      chunk: number;
      mask: number;
    };
    indices: (bs: Uint32Array, len: number, invert?: boolean) => number[];
    range: (arr: number[]) => {
      pos: number;
      length: number;
    }[];
    rangeDebug: (bs: Uint32Array, len: number, invert?: boolean) => string;
    setRange: (
      bs: Uint32Array,
      bsLen: number,
      pos: number,
      len: number,
      allowRewrite?: boolean
    ) => boolean;
  };
  _padLength: typeof padLength;
  _findBytes: typeof findBytes;
  _Reader: typeof _Reader;
  _Writer: typeof _Writer;
  Path: {
    /**
     * Internal method for handling stack of paths (debug, errors, dynamic fields via path)
     * This callback shape forces stack cleanup by construction:
     * `.pop()` always happens after the wrapped function.
     * Also, this makes impossible:
     * - pushing field when stack is empty
     * - pushing field inside of field (real bug)
     * NOTE: we don't want to do '.pop' on error!
     */
    pushObj: (stack: PathStack, obj: StructOut, objFn: _PathObjFn) => void;
    path: (stack: PathStack) => string;
    err(name: string, stack: PathStack, msg: string | Error): Error;
    resolve: (stack: PathStack, path: string) => StructOut | undefined;
  };
} = /* @__PURE__ */ Object.freeze({
  _bitset: Bitset,
  _padLength: padLength,
  _findBytes: findBytes,
  _Reader,
  _Writer,
  Path,
});
