/**
 * Demo oracle service — 5 independent BTCUSD price oracles in one process.
 *
 * Every tick (5s) the service moves a simulated price (random walk around
 * `--spot`, default $115,000) and each oracle signs the attestation digest
 * sha256(tickerHash || u64le(priceCents) || u64le(unixTs)) with its BIP-340
 * key. The human-readable form of what is being attested is
 * `BTCUSD|PRICE_IN_CENTS|UNIXTIMESTAMP`; the digest binds the same fields in
 * fixed 8-byte little-endian encoding (the contract language has no string
 * values, so the covenant rebuilds the binary form with num2bin).
 *
 * HTTP API (port 9010):
 *   GET  /info                    → { ticker, tickerHash, oracles[5], priceWindow }
 *   GET  /price                   → latest PriceTick
 *   GET  /attestations?from=&to=  → PriceTick[] within [from, to]
 *   POST /price { priceCents }    → pin the price (force ITM/OTM for the demo)
 *
 * Flags: --spot <cents>  starting price
 *        --drop-oracle <i>  oracle i stops signing (settlement still works
 *                           with 3 of the remaining signers)
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import {
  arg,
  attestationDigest,
  loadState,
  now,
  saveState,
  tickerHash,
  TICKER,
  fmtUsd,
  type PriceTick,
} from "./contract.ts";

const PORT = 9010;
const TICK_SECONDS = 5;
const HISTORY_TICKS = 2000; // ~2h45m of history for post-expiry settlement
const PRICE_WINDOW = 60; // seconds — the spec's "T minus 1 minute"

// --- Oracle keys (persisted across runs) -----------------------------------

const keys = loadState<string[] | null>("oracle-keys", null) ?? (() => {
  const fresh = Array.from({ length: 5 }, () => hex.encode(randomBytes(32)));
  saveState("oracle-keys", fresh);
  return fresh;
})();
const privs = keys.map((k) => hex.decode(k));
const pubs = privs.map((k) => hex.encode(schnorr.getPublicKey(k)));

const dropped = new Set(
  (arg("--drop-oracle") ?? "").split(",").filter(Boolean).map(Number),
);

// --- Price simulation -------------------------------------------------------

let priceCents = Number(arg("--spot") ?? 115_000_00);
let pinned = false;

const history: PriceTick[] = [];

function tick() {
  if (!pinned) {
    // ±0.05% random walk per tick — enough motion to be visible, small enough
    // that a 1-minute settlement window stays tight.
    const drift = 1 + (Math.random() - 0.5) * 0.001;
    priceCents = Math.max(1, Math.round(priceCents * drift));
  }
  const timestamp = now();
  const digest = attestationDigest(tickerHash, priceCents, timestamp);
  const attestations = privs.flatMap((priv, i) =>
    dropped.has(i)
      ? []
      : [{ oracle: pubs[i], sig: hex.encode(schnorr.sign(digest, priv)) }],
  );
  history.push({
    display: `${TICKER}|${priceCents}|${timestamp}`,
    priceCents,
    timestamp,
    attestations,
  });
  if (history.length > HISTORY_TICKS) history.shift();
}

// --- HTTP -------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && url.pathname === "/info") {
      return json(200, {
        ticker: TICKER,
        tickerHash: hex.encode(tickerHash),
        oracles: pubs,
        priceWindow: PRICE_WINDOW,
      });
    }
    if (req.method === "GET" && url.pathname === "/price") {
      const latest = history[history.length - 1];
      return latest ? json(200, latest) : json(503, { error: "no tick yet" });
    }
    if (req.method === "GET" && url.pathname === "/attestations") {
      const from = Number(url.searchParams.get("from") ?? 0);
      const to = Number(url.searchParams.get("to") ?? Number.MAX_SAFE_INTEGER);
      return json(
        200,
        history.filter((t) => t.timestamp >= from && t.timestamp <= to),
      );
    }
    if (req.method === "POST" && url.pathname === "/price") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { priceCents: p } = JSON.parse(body || "{}");
      if (!Number.isInteger(p) || p <= 0) {
        return json(400, { error: "priceCents must be a positive integer" });
      }
      priceCents = p;
      pinned = true;
      tick();
      console.log(`price pinned to ${fmtUsd(priceCents)}`);
      return json(200, history[history.length - 1]);
    }
    json(404, { error: "not found" });
  } catch (e) {
    json(500, { error: String(e) });
  }
});

export function runOracle() {
  tick();
  setInterval(tick, TICK_SECONDS * 1000);
  server.listen(PORT, () => {
    console.log(`oracle service on :${PORT} — ${TICKER} @ ${fmtUsd(priceCents)}`);
    pubs.forEach((p, i) =>
      console.log(`  oracle[${i}] ${p}${dropped.has(i) ? "  (dropped)" : ""}`),
    );
    console.log(`  attesting every ${TICK_SECONDS}s as '${TICKER}|<cents>|<unix-ts>'`);
    console.log(`  POST /price {"priceCents": N} to pin the price`);
  });
}
