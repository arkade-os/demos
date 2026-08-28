/**
 * Shared contract plumbing for the covered-call demo:
 *
 * - translates the vendored Arkade compiler artifact (covered-call.json,
 *   generated from examples/options/oracle_covered_call.ark in the compiler
 *   repo) into the SDK's `arkade.Program` shape,
 * - derives the contract instance/address from a canonical parameter set that
 *   writer and solver each rebuild independently (never trusting the other
 *   side's copy of their own keys),
 * - mirrors the covenant's payoff split and attestation digest so both sides
 *   compute settlement identically,
 * - small state-file and HTTP helpers shared by the CLI and the daemon.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import {
  arkade,
  ArkAddress,
  networks,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  type Identity,
} from "@arkade-os/sdk";

export const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
export const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
export const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;
export const ORACLE_URL = "http://localhost:9010" as const;
export const SOLVER_URL = "http://localhost:9011" as const;

export const TICKER = "BTCUSD" as const;
export const DUST = 330n;

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));

// --- Artifact → arkade.Program translation ---------------------------------

type CompilerParam = { name: string; type: string };
type CompilerLeaf = {
  name: string;
  witness: { name: string; type: string; injected?: boolean }[];
  asm: string[];
};
type CompilerFunction = {
  name: string;
  arkade?: { inputs: CompilerParam[]; asm: string[] };
  leaves: CompilerLeaf[];
};
export type CompilerArtifact = {
  contractName: string;
  constructorInputs: CompilerParam[];
  functions: CompilerFunction[];
};

export const artifact: CompilerArtifact = JSON.parse(
  readFileSync(join(DEMO_DIR, "covered-call.json"), "utf-8"),
);

/**
 * Local structural aliases for the SDK's `arkade.Program` model — the
 * published rollup types don't allow `arkade.X` type qualification through a
 * named namespace import; these stay assignment-compatible with the SDK.
 */
export type ParamValue = Uint8Array | bigint | number;
type TapscriptSeg = {
  signers: (string | Uint8Array)[];
  csv?: { type: "blocks" | "seconds"; value: bigint | string };
  cltv?: bigint | string;
};
type ProgramFunction = {
  inputs?: { name: string; type: "bytes" | "pubkey" | "sig" | "hash" | "int" }[];
  tapscript: TapscriptSeg;
  arkadeScript?: { asm: (string | number | bigint | Uint8Array)[]; witness?: string[] };
};
export type ContractProgram = {
  version: number;
  name?: string;
  params?: { name: string; type: "bytes" | "pubkey" | "sig" | "hash" | "int" }[];
  functions: Record<string, ProgramFunction>;
};

/** `pubkey[5]` → `["oracles_0", ...]`; scalars stay as-is (compiler ABI expansion). */
function expandParams(params: CompilerParam[]): CompilerParam[] {
  const out: CompilerParam[] = [];
  for (const p of params) {
    const m = p.type.match(/^(\w+)\[(\d+)\]$/);
    if (m) {
      for (let i = 0; i < Number(m[2]); i++)
        out.push({ name: `${p.name}_${i}`, type: m[1] });
    } else {
      out.push(p);
    }
  }
  return out;
}

const SDK_TYPES: Record<string, "bytes" | "pubkey" | "sig" | "hash" | "int"> = {
  pubkey: "pubkey",
  signature: "sig",
  bytes32: "hash",
  bytes: "bytes",
  int: "int",
};

function sdkType(t: string) {
  const mapped = SDK_TYPES[t];
  if (!mapped) throw new Error(`untranslatable param type '${t}'`);
  return mapped;
}

/**
 * One covenant asm token, compiler → SDK:
 * `<name>` placeholders become `$name` refs, `OP_N` small ints become numbers,
 * bare decimals become bigints, opcode names drop the `OP_` prefix.
 */
function covenantToken(tok: string): string | number | bigint {
  const ph = tok.match(/^<(\w+)>$/);
  if (ph) return `$${ph[1]}`;
  if (tok === "OP_0" || tok === "OP_FALSE") return 0;
  if (tok === "OP_TRUE") return 1;
  if (tok === "OP_1NEGATE") return -1;
  const opn = tok.match(/^OP_(\d+)$/);
  if (opn && Number(opn[1]) >= 1 && Number(opn[1]) <= 16) return Number(opn[1]);
  if (/^-?\d+$/.test(tok)) return BigInt(tok);
  if (tok.startsWith("OP_")) return tok.slice(3);
  throw new Error(`untranslatable covenant token '${tok}'`);
}

/**
 * Parse a compiler tapscript leaf (`[<n> CLTV DROP] [<n> CSV DROP]
 * <key> CHECKSIGVERIFY ... <key> CHECKSIG`) into an SDK tapscript segment.
 * The function-tweaked `<EMULATOR_KEY:fn>` signer is dropped: the SDK appends
 * the tweaked co-signer key itself whenever the function has an arkadeScript.
 */
function leafToTapscript(
  leaf: CompilerLeaf,
  hasCovenant: boolean,
): TapscriptSeg {
  const toks = [...leaf.asm];
  const seg: { signers: string[]; csv?: { type: "blocks"; value: string }; cltv?: string } = { signers: [] };

  const timelock = () => {
    const ph = toks[0]?.match(/^<(\w+)>$/);
    if (!ph) return;
    if (toks[1] === "OP_CHECKLOCKTIMEVERIFY" && toks[2] === "OP_DROP") {
      seg.cltv = `$${ph[1]}`;
      toks.splice(0, 3);
    } else if (toks[1] === "OP_CHECKSEQUENCEVERIFY" && toks[2] === "OP_DROP") {
      seg.csv = { type: "blocks", value: `$${ph[1]}` };
      toks.splice(0, 3);
    }
  };
  timelock();

  while (toks.length > 0) {
    const key = toks.shift()!;
    const op = toks.shift();
    if (op !== "OP_CHECKSIGVERIFY" && op !== "OP_CHECKSIG") {
      throw new Error(`unexpected leaf tokens in '${leaf.name}': ${key} ${op}`);
    }
    if (key === "<SERVER_KEY>") {
      seg.signers.push("$server");
    } else if (/^<EMULATOR_KEY:\w+>$/.test(key)) {
      if (!hasCovenant || toks.length > 0) {
        throw new Error(`unexpected emulator key position in leaf '${leaf.name}'`);
      }
      // dropped — auto-appended by the SDK for covenant functions
    } else {
      const ph = key.match(/^<(\w+)>$/);
      if (!ph) throw new Error(`unexpected leaf key token '${key}'`);
      seg.signers.push(`$${ph[1]}`);
    }
  }
  if (seg.signers.length === 0) {
    throw new Error(`leaf '${leaf.name}' has no non-emulator signers`);
  }
  return seg;
}

/**
 * Translate the compiler artifact into an SDK Program.
 *
 * The covenant witness stack: the compiler reads function inputs from
 * pre-existing stack slots where the FIRST declared input is on top, so the
 * EmulatorPacket witness array (element 0 = stack bottom) lists the expanded
 * inputs in REVERSE declared order.
 */
export function artifactToProgram(a: CompilerArtifact): ContractProgram {
  const functions: Record<string, ProgramFunction> = {};
  for (const fn of a.functions) {
    if (fn.leaves.length !== 1) {
      throw new Error(`function '${fn.name}': expected exactly one leaf`);
    }
    const inputs = fn.arkade ? expandParams(fn.arkade.inputs) : [];
    functions[fn.name] = {
      ...(inputs.length > 0
        ? { inputs: inputs.map((i) => ({ name: i.name, type: sdkType(i.type) })) }
        : {}),
      tapscript: leafToTapscript(fn.leaves[0], fn.arkade !== undefined),
      ...(fn.arkade
        ? {
            arkadeScript: {
              asm: fn.arkade.asm.map(covenantToken),
              witness: inputs.map((i) => i.name).reverse(),
            },
          }
        : {}),
    };
  }
  return {
    version: 0,
    name: a.contractName,
    params: [
      ...expandParams(a.constructorInputs).map((p) => ({
        name: p.name,
        type: sdkType(p.type),
      })),
      { name: "server", type: "pubkey" as const },
    ],
    functions,
  };
}

export const program = artifactToProgram(artifact);

// --- Canonical contract parameters -----------------------------------------

/** Wire form of the full parameter set (hex strings + numbers), as exchanged over RFQ. */
export type CCParams = {
  writerPk: string;
  holderPk: string;
  writerScript: string; // 32-byte taproot witness program (payout destination)
  holderScript: string;
  oracles: string[]; // 5 x-only pubkeys
  tickerHash: string; // sha256("BTCUSD")
  strike: number; // USD cents per BTC
  expiry: number; // unix seconds
  priceWindow: number; // seconds
  refundAt: number; // unix seconds
  notional: number; // sats
  coopExit: number; // CSV blocks
  exit: number; // CSV blocks
};

export function contractArgs(p: CCParams): Record<string, ParamValue> {
  if (p.oracles.length !== 5) throw new Error("expected 5 oracles");
  const args: Record<string, ParamValue> = {
    writerPk: hex.decode(p.writerPk),
    holderPk: hex.decode(p.holderPk),
    writerScript: hex.decode(p.writerScript),
    holderScript: hex.decode(p.holderScript),
    tickerHash: hex.decode(p.tickerHash),
    strike: BigInt(p.strike),
    expiry: BigInt(p.expiry),
    priceWindow: BigInt(p.priceWindow),
    refundAt: BigInt(p.refundAt),
    notional: BigInt(p.notional),
    coopExit: BigInt(p.coopExit),
    exit: BigInt(p.exit),
  };
  p.oracles.forEach((o, i) => (args[`oracles_${i}`] = hex.decode(o)));
  return args;
}

/** Field-wise equality of two parameter sets (key order and extra fields must not matter). */
export function sameParams(a: CCParams, b: CCParams): boolean {
  const scalar: (keyof CCParams)[] = [
    "writerPk", "holderPk", "writerScript", "holderScript", "tickerHash",
    "strike", "expiry", "priceWindow", "refundAt", "notional", "coopExit", "exit",
  ];
  return (
    scalar.every((k) => a[k] === b[k]) &&
    a.oracles.length === 5 &&
    b.oracles.length === 5 &&
    a.oracles.every((o, i) => o === b.oracles[i])
  );
}

export type ArkadeClient = Awaited<ReturnType<typeof arkade.Arkade.connect>>;

export async function connectArkade(identity?: Identity): Promise<ArkadeClient> {
  return arkade.Arkade.connect({
    arkade: new RestArkProvider(OPERATOR_URL),
    indexer: new RestIndexerProvider(OPERATOR_URL),
    emulator: new RestEmulatorProvider(EMULATOR_URL),
    network: networks.mutinynet,
    ...(identity ? { identity } : {}),
  });
}

export function deriveContract(client: ArkadeClient, p: CCParams) {
  return client.contract(program, contractArgs(p));
}

/** Full taproot output script (`OP_1 <32B>`) from a 32-byte witness program. */
export function p2trScript(program32: Uint8Array): Uint8Array {
  if (program32.length !== 32) throw new Error("expected a 32-byte witness program");
  return new Uint8Array([0x51, 0x20, ...program32]);
}

/** The 32-byte vtxo taproot program of an ark address (used as payout script param). */
export function programOfAddress(address: string): Uint8Array {
  return ArkAddress.decode(address).vtxoTaprootKey;
}

// --- Oracle attestation encoding -------------------------------------------

/**
 * Digest the oracles sign — sha256(tickerHash || u64le(priceCents) || u64le(ts)).
 * Numeric fields are 8-byte little-endian (the contract rebuilds them with
 * num2bin(x, 8)); the human-readable form is `BTCUSD|PRICE_IN_CENTS|UNIXTS`.
 */
export function attestationDigest(
  tickerHash: Uint8Array,
  priceCents: bigint | number,
  timestamp: bigint | number,
): Uint8Array {
  const buf = new Uint8Array(48);
  buf.set(tickerHash, 0);
  const view = new DataView(buf.buffer);
  view.setBigUint64(32, BigInt(priceCents), true);
  view.setBigUint64(40, BigInt(timestamp), true);
  return sha256(buf);
}

export const tickerHash = sha256(new TextEncoder().encode(TICKER));

export type Attestation = { oracle: string; sig: string };
export type PriceTick = {
  display: string;
  priceCents: number;
  timestamp: number;
  attestations: Attestation[];
};

// --- Settlement math (mirrors the covenant exactly) -------------------------

export function median3(a: bigint, b: bigint, c: bigint): bigint {
  const s = [a, b, c].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return s[1];
}

/**
 * The covenant's payoff split. `outputs` is what the settle tx must pay,
 * in covenant output order.
 */
export function payoffSplit(
  notional: bigint,
  strike: bigint,
  st: bigint,
): { holderSats: bigint; writerSats: bigint; outputs: ("holder" | "writer")[] } {
  if (st <= strike) {
    return { holderSats: 0n, writerSats: notional, outputs: ["writer"] };
  }
  const writerSats = (notional * strike) / st;
  const holderSats = notional - writerSats;
  if (holderSats < DUST) {
    return { holderSats: 0n, writerSats: notional, outputs: ["writer"] };
  }
  if (writerSats < DUST) {
    return { holderSats: notional, writerSats: 0n, outputs: ["holder"] };
  }
  return { holderSats, writerSats, outputs: ["holder", "writer"] };
}

/**
 * Build and submit the settle transaction — the permissionless crank. The
 * caller supplies exactly 3 attestations from 3 distinct oracles, each
 * timestamped inside [expiry - priceWindow, expiry].
 */
export async function settleContract(
  client: ArkadeClient,
  params: CCParams,
  picks: { oracleIdx: number; priceCents: bigint; timestamp: bigint; sig: Uint8Array }[],
): Promise<{ txid: string; st: bigint; holderSats: bigint; writerSats: bigint }> {
  if (picks.length !== 3) throw new Error("need exactly 3 attestations");
  if (new Set(picks.map((p) => p.oracleIdx)).size !== 3) {
    throw new Error("attestations must come from 3 distinct oracles");
  }
  const st = median3(picks[0].priceCents, picks[1].priceCents, picks[2].priceCents);
  const split = payoffSplit(BigInt(params.notional), BigInt(params.strike), st);

  const contract = deriveContract(client, params);
  const utxos = await contract.getUtxos();
  const vault = utxos.find((u) => BigInt(u.value) === BigInt(params.notional));
  if (!vault) {
    throw new Error(
      `no vault VTXO of exactly ${params.notional} sats at ${contract.address}`,
    );
  }

  const scripts = {
    holder: p2trScript(hex.decode(params.holderScript)),
    writer: p2trScript(hex.decode(params.writerScript)),
  };
  const amounts = { holder: split.holderSats, writer: split.writerSats };
  let builder = contract.functions
    .settle(
      picks[0].oracleIdx,
      picks[1].oracleIdx,
      picks[2].oracleIdx,
      picks[0].priceCents,
      picks[1].priceCents,
      picks[2].priceCents,
      picks[0].timestamp,
      picks[1].timestamp,
      picks[2].timestamp,
      picks[0].sig,
      picks[1].sig,
      picks[2].sig,
    )
    .from(vault);
  for (const leg of split.outputs) {
    const amount = split.outputs.length === 1 ? BigInt(params.notional) : amounts[leg];
    builder = builder.to(scripts[leg], amount);
  }
  const { txid } = await builder.send();
  return { txid, st, holderSats: split.holderSats, writerSats: split.writerSats };
}

/**
 * Choose the settlement attestations from an oracle history: for each oracle,
 * the latest tick inside [expiry - priceWindow, expiry]; then the first three
 * distinct oracles. Throws when fewer than 3 oracles attested in the window.
 */
export function pickAttestations(
  ticks: PriceTick[],
  oracles: string[],
  expiry: number,
  priceWindow: number,
): { oracleIdx: number; priceCents: bigint; timestamp: bigint; sig: Uint8Array }[] {
  const from = expiry - priceWindow;
  const best = new Map<number, { priceCents: bigint; timestamp: bigint; sig: Uint8Array }>();
  for (const tick of ticks) {
    if (tick.timestamp < from || tick.timestamp > expiry) continue;
    for (const att of tick.attestations) {
      const idx = oracles.indexOf(att.oracle);
      if (idx === -1) continue;
      const prev = best.get(idx);
      if (!prev || BigInt(tick.timestamp) > prev.timestamp) {
        best.set(idx, {
          priceCents: BigInt(tick.priceCents),
          timestamp: BigInt(tick.timestamp),
          sig: hex.decode(att.sig),
        });
      }
    }
  }
  const picks = [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, 3)
    .map(([oracleIdx, a]) => ({ oracleIdx, ...a }));
  if (picks.length < 3) {
    throw new Error(
      `only ${picks.length} distinct oracles attested in [${from}, ${expiry}] — need 3`,
    );
  }
  return picks;
}

// --- Tiny state / HTTP helpers ---------------------------------------------

const STATE_DIR = join(DEMO_DIR, ".state");

export function loadState<T>(name: string, fallback: T): T {
  const file = join(STATE_DIR, `${name}.json`);
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

export function saveState(name: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `${name}.json`), JSON.stringify(value, null, 2));
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export const now = () => Math.floor(Date.now() / 1000);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const fmtUsd = (cents: number | bigint) =>
  `$${(Number(cents) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
export const fmtSats = (sats: number | bigint) => `${Number(sats).toLocaleString("en-US")} sats`;
