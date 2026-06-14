import { base64, hex } from '@scure/base';
import {
  EMPTY,
  _TEST,
  wrap as coderWrap,
  utils,
  type Bytes,
  type CoderType,
  type Reader,
  type StructOut,
  type TArg,
  type TRet,
  type Writer,
  type _PathObjFn,
} from './index.ts';

const UNKNOWN = '(???)';
const codes = { esc: 27, nl: 10 };
const esc = /* @__PURE__ */ (() => String.fromCharCode(codes.esc))();
const nl = /* @__PURE__ */ (() => String.fromCharCode(codes.nl))();

const bold = /* @__PURE__ */ (() => esc + '[1m')();
const gray = /* @__PURE__ */ (() => esc + '[90m')();
const reset = /* @__PURE__ */ (() => esc + '[0m')();
const red = /* @__PURE__ */ (() => esc + '[31m')();
const green = /* @__PURE__ */ (() => esc + '[32m')();
const yellow = /* @__PURE__ */ (() => esc + '[33m')();

type DebugPath = { start: number; end?: number; path: string; value?: any };
const DebugReader = /* @__PURE__ */ (() =>
  class DebugReader extends _TEST._Reader {
    debugLst: DebugPath[] = [];
    cur?: DebugPath;
    get lastElm() {
      if (this.debugLst.length) return this.debugLst[this.debugLst.length - 1];
      return { start: 0, end: 0, path: '' };
    }
    pushObj(obj: StructOut, objFn: _PathObjFn) {
      return _TEST.Path.pushObj(this.stack, obj, (cb) => {
        objFn((field: string, fieldFn: Function) => {
          cb(field, () => {
            {
              const last = this.lastElm;
              if (last.end === undefined) last.end = this.pos;
              else if (last.end !== this.pos) {
                this.debugLst.push({
                  path: `${_TEST.Path.path(this.stack)}/${UNKNOWN}`,
                  start: last.end,
                  end: this.pos,
                });
              }
              this.cur = { path: `${_TEST.Path.path(this.stack)}/${field}`, start: this.pos };
            }
            fieldFn();
            {
              // happens if pop after pop (exit from nested structure)
              // Nested struct-like fields emit child entries instead of a parent entry,
              // so unwinding leaves `this.cur` cleared by the inner callback.
              if (!this.cur) {
                const last = this.lastElm;
                if (last.end === undefined) last.end = this.pos;
                else if (last.end !== this.pos) {
                  this.debugLst.push({
                    start: last.end,
                    end: this.pos,
                    path: last.path + `/${UNKNOWN}`,
                  });
                }
              } else {
                this.cur.end = this.pos;
                const last = this.stack[this.stack.length - 1];
                const lastItem = last.obj;
                const lastField = last.field;
                if (lastItem && lastField !== undefined) this.cur.value = lastItem[lastField];
                this.debugLst.push(this.cur);
                this.cur = undefined;
              }
            }
          });
        });
      });
    }

    finishDebug(): void {
      const end = this.data.length;
      if (this.cur) this.debugLst.push({ end, ...this.cur });
      const last = this.lastElm;
      // Primitive coders never call pushObj(), so the fallback row must begin at the previous
      // mapped end (0 for an empty map) instead of the already-consumed cursor position.
      if (last.end !== undefined && last.end !== end)
        this.debugLst.push({ start: last.end, end, path: UNKNOWN });
      else if (last.end === undefined) this.debugLst.push({ start: this.pos, end, path: UNKNOWN });
      // Force-printing a successful zero-byte decode still needs a row; table([]) is an error.
      if (!this.debugLst.length) this.debugLst.push({ start: 0, end, path: UNKNOWN });
    }
  })();

function toBytes(data: TArg<string | Bytes>): TRet<Bytes> {
  if (utils.isBytes(data)) return data as TRet<Bytes>;
  if (typeof data !== 'string') throw new Error('PD: data should be string or Uint8Array');
  // Lowercase hex byte dumps such as "cafebabe" are also valid base64, so give them precedence.
  if (!(data.length % 2) && /^[0-9a-f]+$/.test(data)) return hex.decode(data) as TRet<Bytes>;
  try {
    return base64.decode(data) as TRet<Bytes>;
  } catch (e) {}
  throw new Error(`PD: data has unknown string format: ${data}`);
}

type DebugData = { path: string; data: TRet<Bytes>; value?: any };
function mapData(lst: DebugPath[], data: TArg<Bytes>): TRet<DebugData[]> {
  // DebugReader should emit a contiguous ordered partition of the input.
  let end = 0;
  const res: DebugData[] = [];
  for (const elm of lst) {
    if (elm.start !== end) throw new Error(`PD: elm start=${elm.start} after prev elm end=${end}`);
    if (elm.end === undefined) throw new Error(`PD: elm.end is undefined=${elm}`);
    res.push({
      path: elm.path,
      data: Uint8Array.from(data.subarray(elm.start, elm.end)) as TRet<Bytes>,
      value: elm.value,
    });
    end = elm.end;
  }
  if (end !== data.length) throw new Error('PD: not all data mapped');
  return res as TRet<DebugData[]>;
}

function chrWidth(s: string): number {
  /*
  It is almost impossible to find out real characters width in terminal since it depends on terminal itself, current unicode version and moon's phase.
  So, we just stripping ANSI, tabs and unicode supplimental characters. Emoji support requires big tables (and have no guarantee to work), so we ignore it for now.
  Also, no support for full width unicode characters for now.
  Normalize every tab; replacing only the first one undercounts table padding.
  */
  return s
    .replace(
      /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g,
      ''
    )
    .replace(/\t/g, '  ')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ' ').length;
}

function wrap(s: string, padding: number = 0) {
  // @ts-ignore
  const columns = process.stdout.columns;
  // Non-TTY stdout has no width; tiny widths also cannot fit a useful ellipsis.
  if (typeof columns !== 'number') return s;
  const limit = columns - 3 - padding;
  if (limit <= 0) return s;
  if (chrWidth(s) <= limit) return s;
  while (chrWidth(s) > limit) s = s.slice(0, -1);
  return `${s}${reset}...`;
}

/**
 * Print an array of rows as a formatted terminal table.
 * @param data - Rows to print.
 * @throws If the table has no printable columns or rows. {@link Error}
 * @example
 * Print a quick table with auto-sized columns.
 * ```ts
 * import { table } from 'micro-packed/debugger.js';
 * table([{ Name: 'field', Value: '01ff' }]);
 * ```
 */
export function table(data: any[]): void {
  let res: string[] = [];
  const str = (v: any) => (v === undefined ? '' : '' + v);
  const pad = (s: string, width: number) =>
    `${s}${''.padEnd(Math.max(0, width - chrWidth(s)), ' ')}`;
  let widths: Record<string, number> = {};
  for (let elm of data) {
    for (let k in elm) {
      widths[k] = Math.max(
        widths[k] || 0,
        chrWidth(str(k)),
        str(elm[k])
          .split(nl)
          .reduce((a, b) => Math.max(a, chrWidth(b)), 0)
      );
    }
  }
  const columns = Object.keys(widths);
  if (!data.length || !columns.length) throw new Error('No data');
  const padding = ` ${reset}${gray}│${reset} `;
  res.push(wrap(` ${columns.map((c) => `${bold}${pad(c, widths[c])}`).join(padding)}${reset}`, 3));
  for (let idx = 0; idx < data.length; idx++) {
    const elm = data[idx];
    const row = columns.map((i) => str(elm[i]).split(nl));
    let message = [...Array(Math.max(...row.map((i) => i.length))).keys()]
      .map((line) => row.map((c, i) => pad(str(c[line]), widths[columns[i]])))
      .map((line, _) => wrap(` ${line.join(padding)} `, 1))
      .join(nl);
    res.push(message);
  }
  for (let i = 0; i < res.length; i++) {
    const border = columns
      .map((c) => ''.padEnd(widths[c], '─'))
      .join(`─${i === res.length - 1 ? '┴' : '┼'}─`);
    res[i] += wrap(`${nl}${reset}${gray}─${border}─${reset}`);
  }
  // @ts-ignore
  console.log(res.join(nl));
}

function fmtData(data: TArg<Bytes>, perLine = 8) {
  const res = [];
  for (let i = 0; i < data.length; i += perLine) {
    res.push(hex.encode(data.subarray(i, i + perLine)));
  }
  return res.map((i) => `${bold}${i}${reset}`).join(nl);
}

function fmtValue(value: any) {
  if (utils.isBytes(value)) return `b(${green}${hex.encode(value)}${reset} len=${value.length})`;
  if (typeof value === 'string') return `s(${green}"${value}"${reset} len=${value.length})`;
  if (typeof value === 'number' || typeof value === 'bigint') return `n(${value})`;
  // console.log('fmt', value);
  // if (Object.prototype.toString.call(value) === '[object Object]') return inspect(value);
  return '' + value;
}

/**
 * Decode input while printing the partially decoded map when an error occurs.
 * @param coder - Coder used for the decode step.
 * @param data - Hex, base64, or raw bytes to decode.
 * @param forcePrint - Print the decoded map even when decoding succeeds.
 * @returns Decoded value produced by `coder`.
 * @throws If decoding the input fails. {@link Error}
 * @example
 * Inspect a failing decode and print the consumed fields before rethrowing.
 * ```ts
 * import { U32LE } from 'micro-packed';
 * import { decode } from 'micro-packed/debugger.js';
 * decode(U32LE, Uint8Array.of(1, 0, 0, 0));
 * ```
 */
export function decode(
  coder: CoderType<any>,
  data: TArg<string | Bytes>,
  forcePrint = false
): ReturnType<(typeof coder)['decode']> {
  data = toBytes(data);
  const r = new DebugReader(data);
  let res, e;
  try {
    res = coder.decodeStream(r);
    r.finish();
  } catch (_e) {
    e = _e;
  }
  r.finishDebug();
  if (e || forcePrint) {
    // @ts-ignore
    console.log('==== DECODED BEFORE ERROR ====');
    table(
      mapData(r.debugLst, data).map((elm) => ({
        Data: fmtData(elm.data),
        Len: elm.data.length,
        Path: `${green}${elm.path}${reset}`,
        Value: fmtValue(elm.value),
      }))
    );
    // @ts-ignore
    console.log('==== /DECODED BEFORE ERROR ====');
  }
  if (e) throw e;
  return res;
}

function getMap(coder: CoderType<any>, data: TArg<string | Bytes>) {
  data = toBytes(data);
  const r = new DebugReader(data);
  coder.decodeStream(r);
  r.finish();
  r.finishDebug();
  return mapData(r.debugLst, data);
}

function diffData(a: TArg<Bytes>, e: TArg<Bytes>) {
  const len = Math.max(a.length, e.length);
  let outA = '',
    outE = '';
  const charHex = (n: number) => n.toString(16).padStart(2, '0');
  for (let i = 0; i < len; i++) {
    const [aI, eI] = [a[i], e[i]];
    if (i && !(i % 8)) {
      if (aI !== undefined) outA += nl;
      if (eI !== undefined) outE += nl;
    }
    if (aI !== undefined) outA += aI === eI ? charHex(aI) : `${yellow}${charHex(aI)}${reset}`;
    if (eI !== undefined) outE += aI === eI ? charHex(eI) : `${yellow}${charHex(eI)}${reset}`;
  }
  return [outA, outE];
}

function diffPath(a: string, e: string) {
  if (a === e) return a;
  return `A: ${red}${a}${reset}${nl}E: ${green}${e}${reset}`;
}
function diffLength(a: TArg<Bytes>, e: TArg<Bytes>) {
  const [aLen, eLen] = [a.length, e.length];
  if (aLen === eLen) return aLen;
  return `A: ${red}${aLen}${reset}${nl}E: ${green}${eLen}${reset}`;
}

function diffValue(a: any, e: any) {
  const [aV, eV] = [a, e].map(fmtValue);
  if (aV === eV) return aV;
  return `A: ${red}${aV}${reset}${nl}E: ${green}${eV}${reset}`;
}

/**
 * Print a field-by-field diff between two encoded payloads.
 * @param coder - Coder used to decode both payloads before diffing.
 * @param actual - Actual bytes or encoded string.
 * @param expected - Expected bytes or encoded string.
 * @param skipSame - Skip rows whose decoded values are identical.
 * @throws If either payload cannot be decoded for diffing. {@link Error}
 * @example
 * Compare two encoded payloads field by field.
 * ```ts
 * import { U16BE, struct } from 'micro-packed';
 * import { diff } from 'micro-packed/debugger.js';
 * const coder = struct({ value: U16BE });
 * diff(coder, Uint8Array.of(0, 1), Uint8Array.of(0, 2), false);
 * ```
 */
export function diff(
  coder: CoderType<any>,
  actual: TArg<string | Bytes>,
  expected: TArg<string | Bytes>,
  skipSame = true
): void {
  // @ts-ignore
  console.log('==== DIFF ====');
  const [_actual, _expected] = [actual, expected].map((i) => getMap(coder, i)) as [
    DebugData[],
    DebugData[],
  ];
  const len = Math.max(_actual.length, _expected.length);
  const data = [];
  const DEF = { data: EMPTY, path: '' };
  for (let i = 0; i < len; i++) {
    const [a, e] = [_actual[i] || DEF, _expected[i] || DEF];
    if (utils.equalBytes(a.data, e.data) && skipSame) continue;
    const [adata, edata] = diffData(a.data, e.data);
    data.push({
      'Data (A)': adata,
      'Data (E)': edata,
      Len: diffLength(a.data, e.data),
      Path: diffPath(a.path, e.path),
      Value: diffValue(a.value, e.value),
    });
  }
  // Identical payloads with skipSame=true leave no rows; an empty diff is still successful.
  if (data.length > 0) table(data);
  // @ts-ignore
  console.log('==== /DIFF ====');
}

/**
 * Wraps a CoderType with debug logging for encoding and decoding operations.
 * @param inner - Inner CoderType to wrap.
 * @returns Inner wrapped in debug prints via console.log.
 * @throws If the inner coder is invalid. {@link Error}
 * @example
 * Print each encode/decode step while keeping the original coder API.
 * ```ts
 * import { U32LE } from 'micro-packed';
 * import { debug } from 'micro-packed/debugger.js';
 * const debugInt = debug(U32LE); // Will print info to console on encoding/decoding
 * ```
 */
export function debug<T>(inner: CoderType<T>): CoderType<T> {
  if (!utils.isCoder(inner)) throw new Error(`debug: invalid inner value ${inner}`);
  const log = (name: string, rw: TArg<Reader | Writer>, value: any) => {
    // @ts-ignore
    console.log(`DEBUG/${name}(${_TEST.Path.path(rw.stack)}):`, { type: typeof value, value });
    return value;
  };
  return coderWrap({
    size: inner.size,
    encodeStream: (w: TArg<Writer>, value: T) => inner.encodeStream(w, log('encode', w, value)),
    decodeStream: (r: TArg<Reader>): T => log('decode', r, inner.decodeStream(r)),
  });
}

// Test-only export needs explicit members for isolated declaration emit.
export const _TESTS: { chrWidth: (s: string) => number } = /* @__PURE__ */ Object.freeze({
  chrWidth: chrWidth,
});
