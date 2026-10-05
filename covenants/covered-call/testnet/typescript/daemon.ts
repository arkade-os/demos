/**
 * Solver daemon — the market-maker / option HOLDER side of the RFQ flow
 * (run with `--daemon`).
 *
 * Issuance (spec: "D = W" — the user is the writer):
 *   1. GET  /info → market: strike grid (5 strikes, $5K steps at/above spot),
 *      expiries, notional bounds, the solver's holder keys, timelock terms.
 *   2. POST /rfq  → premium quote for (notional, strike, expiry).
 *   3. POST /accept → the writer announces its side (keys, payout script,
 *      premium address) plus the full derived parameter set; the daemon
 *      re-derives the contract from ITS OWN view (own holder keys, oracle set
 *      fetched from the oracle service directly, quoted terms) and refuses on
 *      any mismatch — it never trusts the writer's copy of solver-owned or
 *      oracle-owned fields.
 *   4. The watcher waits for the vault to be funded with exactly `notional`
 *      in a single VTXO, then pays the premium to the writer's ark address
 *      (spec order: user locks Q, solver transfers V). The 30-second
 *      atomic-finalize refund of the spec needs intent infrastructure that is
 *      out of scope here — this demo pays promptly and marks the position.
 *   5. At expiry the daemon fetches the oracle attestations timestamped in
 *      [expiry - priceWindow, expiry] and cranks `settle` — ITM or OTM alike
 *      (settlement is permissionless; the writer CLI can crank it too).
 *
 * Toy quote model (NOT a pricing engine): premium ≈ notional · 0.4 · IV ·
 * sqrt(T_years) · exp(-6 · OTM-distance), IV pinned at 60%. Good enough to
 * make quotes move with tenor and moneyness in a demo.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { hex } from "@scure/base";
import {
  connectArkade,
  deriveContract,
  fmtSats,
  fmtUsd,
  getJSON,
  loadState,
  now,
  ORACLE_URL,
  pickAttestations,
  programOfAddress,
  sameParams,
  saveState,
  settleContract,
  sleep,
  type CCParams,
  type PriceTick,
} from "./contract.ts";
import { openWallet } from "./wallet.ts";

const PORT = 9011;
const STRIKE_STEP = 5_000_00; // $5K in cents
const STRIKE_COUNT = 5; // max strikes offered above spot
const QMIN = 20_000; // sats
const QMAX = 5_000_000; // sats
const GRACE = 600; // refundAt = expiry + GRACE (writer reclaim opens)
const COOP_EXIT = 6; // CSV blocks, holder+writer cooperative path
const EXIT = 144; // CSV blocks, writer unilateral exit
const QUOTE_TTL = 120; // seconds a quote stays acceptable
const FUNDING_TIMEOUT = 900; // seconds before an accepted quote is written off
const IV = 0.6;

type Quote = {
  quoteId: string;
  notional: number;
  strike: number;
  expiry: number;
  premiumSats: number;
  createdAt: number;
};

type Position = {
  quoteId: string;
  params: CCParams;
  address: string;
  writerAddress: string;
  premiumSats: number;
  state:
    | "awaiting_funding"
    | "paying_premium"
    | "active"
    | "settled"
    | "expired_unfunded"
    | "closed";
  createdAt: number;
  settlement?: { txid: string; st: number; holderSats: number; writerSats: number };
};

type OracleInfo = { ticker: string; tickerHash: string; oracles: string[]; priceWindow: number };

export async function runDaemon() {
  const { identity, wallet } = await openWallet("solver");
  const holderPk = hex.encode(await identity.xOnlyPublicKey());
  const holderAddress = await wallet.getAddress();
  const holderScript = hex.encode(programOfAddress(holderAddress));
  const client = await connectArkade(identity);

  const quotes = new Map<string, Quote>();
  const positions: Position[] = loadState("solver-positions", [] as Position[]);
  const persist = () => saveState("solver-positions", positions);

  const oracleInfo = await getJSON<OracleInfo>(`${ORACLE_URL}/info`);
  const spot = async () => (await getJSON<PriceTick>(`${ORACLE_URL}/price`)).priceCents;

  /** 5 strikes, $5K grid, at/above the current oracle spot. */
  const strikeGrid = (spotCents: number) => {
    const base = Math.ceil(spotCents / STRIKE_STEP) * STRIKE_STEP;
    return Array.from({ length: STRIKE_COUNT }, (_, i) => base + i * STRIKE_STEP);
  };

  const quotePremium = (notional: number, strike: number, expiry: number, spotCents: number) => {
    const tYears = Math.max(expiry - now(), 60) / 31_536_000;
    const otmDistance = strike / spotCents - 1; // >= 0 on the offered grid
    const premium = Math.round(
      notional * 0.4 * IV * Math.sqrt(tYears) * Math.exp(-6 * otmDistance),
    );
    return Math.max(premium, 1_000);
  };

  /** The daemon's own view of the contract params for an accepted quote. */
  const buildParams = (
    q: Quote,
    writer: { writerPk: string; writerScript: string },
  ): CCParams => ({
    writerPk: writer.writerPk,
    holderPk,
    writerScript: writer.writerScript,
    holderScript,
    oracles: oracleInfo.oracles,
    tickerHash: oracleInfo.tickerHash,
    strike: q.strike,
    expiry: q.expiry,
    priceWindow: oracleInfo.priceWindow,
    refundAt: q.expiry + GRACE,
    notional: q.notional,
    coopExit: COOP_EXIT,
    exit: EXIT,
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const body = async () => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      return JSON.parse(raw || "{}");
    };
    try {
      if (req.method === "GET" && url.pathname === "/info") {
        const s = await spot();
        return json(200, {
          side: "holder (solver / market maker)",
          holderPk,
          holderScript,
          spotCents: s,
          strikes: strikeGrid(s),
          notional: { min: QMIN, max: QMAX },
          terms: { grace: GRACE, coopExit: COOP_EXIT, exit: EXIT },
          oracle: oracleInfo,
        });
      }

      if (req.method === "POST" && url.pathname === "/rfq") {
        const { notional, strike, expiry } = await body();
        const s = await spot();
        if (!Number.isInteger(notional) || notional < QMIN || notional > QMAX) {
          return json(400, { error: `notional must be in [${QMIN}, ${QMAX}] sats` });
        }
        if (!strikeGrid(s).includes(strike)) {
          return json(400, {
            error: `strike must be on the $5K grid within ${STRIKE_COUNT} strikes of spot`,
            strikes: strikeGrid(s),
          });
        }
        if (!Number.isInteger(expiry) || expiry < now() + 90 || expiry > now() + 6 * 3600) {
          return json(400, { error: "expiry must be 90s..6h from now (demo bounds)" });
        }
        const quote: Quote = {
          quoteId: randomUUID(),
          notional,
          strike,
          expiry,
          premiumSats: quotePremium(notional, strike, expiry, s),
          createdAt: now(),
        };
        quotes.set(quote.quoteId, quote);
        console.log(
          `rfq: ${fmtSats(notional)} @ K=${fmtUsd(strike)} T=${expiry} → premium ${fmtSats(quote.premiumSats)}`,
        );
        return json(200, {
          ...quote,
          holderPk,
          holderScript,
          terms: { grace: GRACE, coopExit: COOP_EXIT, exit: EXIT },
        });
      }

      if (req.method === "POST" && url.pathname === "/accept") {
        const { quoteId, writerPk, writerScript, writerAddress, params } = await body();
        const quote = quotes.get(quoteId);
        if (!quote) return json(404, { error: "unknown quote" });
        if (now() - quote.createdAt > QUOTE_TTL) return json(410, { error: "quote expired" });
        if (!/^[0-9a-f]{64}$/.test(writerPk ?? "") || !/^[0-9a-f]{64}$/.test(writerScript ?? "")) {
          return json(400, { error: "writerPk/writerScript must be 32-byte hex" });
        }
        // Re-derive everything from the daemon's own view and refuse mismatches:
        // solver-owned fields (holder keys), oracle-owned fields (set, ticker,
        // window) and the quoted terms are never taken from the writer.
        const ours = buildParams(quote, { writerPk, writerScript });
        if (!params || !sameParams(ours, params)) {
          return json(409, { error: "parameter mismatch", expected: ours });
        }
        const address = deriveContract(client, ours).address;
        const position: Position = {
          quoteId,
          params: ours,
          address,
          writerAddress,
          premiumSats: quote.premiumSats,
          state: "awaiting_funding",
          createdAt: now(),
        };
        positions.push(position);
        persist();
        quotes.delete(quoteId);
        console.log(`accepted ${quoteId}: vault ${address}`);
        return json(200, { contractAddress: address, premiumSats: quote.premiumSats });
      }

      if (req.method === "GET" && url.pathname === "/positions") {
        return json(200, positions);
      }
      json(404, { error: "not found" });
    } catch (e) {
      console.error("http error:", e);
      json(500, { error: String(e) });
    }
  });

  // --- watcher: funding → premium; expiry → settle -------------------------

  async function pump() {
    for (const p of positions) {
      try {
        if (p.state === "awaiting_funding") {
          // Check the vault BEFORE the write-off timer: a funded vault must
          // never be marked unfunded (e.g. after daemon downtime).
          const utxos = await deriveContract(client, p.params).getUtxos();
          const funded =
            utxos.length === 1 && BigInt(utxos[0].value) === BigInt(p.params.notional);
          if (utxos.length > 0 && !funded) {
            console.log(
              `${p.quoteId}: vault funding mismatch (${utxos.length} vtxos) — not activating`,
            );
            continue;
          }
          if (funded) {
            // Persist intent before sending so a crash mid-payment can never
            // double-pay; a position stuck in paying_premium needs a manual
            // check of whether the transfer actually landed.
            p.state = "paying_premium";
            persist();
            const txid = await wallet.send({
              address: p.writerAddress,
              amount: p.premiumSats,
            });
            p.state = "active";
            persist();
            console.log(`${p.quoteId}: funded — premium ${fmtSats(p.premiumSats)} paid (${txid})`);
          } else if (now() - p.createdAt > FUNDING_TIMEOUT) {
            p.state = "expired_unfunded";
            persist();
            console.log(`${p.quoteId}: never funded — written off`);
          }
        } else if (p.state === "paying_premium") {
          console.log(
            `${p.quoteId}: premium payment was interrupted — verify the transfer to ${p.writerAddress} and set state to 'active' or 'awaiting_funding' in .state/solver-positions.json`,
          );
        } else if (p.state === "active" && now() >= p.params.expiry + 5) {
          const utxos = await deriveContract(client, p.params).getUtxos();
          if (utxos.length === 0) {
            p.state = "closed"; // settled/refunded by someone else
            persist();
            continue;
          }
          const ticks = await getJSON<PriceTick[]>(
            `${ORACLE_URL}/attestations?from=${p.params.expiry - p.params.priceWindow}&to=${p.params.expiry}`,
          );
          const picks = pickAttestations(
            ticks,
            p.params.oracles,
            p.params.expiry,
            p.params.priceWindow,
          );
          const result = await settleContract(client, p.params, picks);
          p.state = "settled";
          p.settlement = {
            txid: result.txid,
            st: Number(result.st),
            holderSats: Number(result.holderSats),
            writerSats: Number(result.writerSats),
          };
          persist();
          const itm = BigInt(p.params.strike) < result.st;
          console.log(
            `${p.quoteId}: settled ${itm ? "ITM" : "OTM"} at ST=${fmtUsd(Number(result.st))} — ` +
              `holder ${fmtSats(result.holderSats)}, writer ${fmtSats(result.writerSats)} (${result.txid})`,
          );
        }
      } catch (e) {
        console.error(`${p.quoteId}: ${e}`);
      }
    }
  }

  server.listen(PORT, () => {
    console.log(`solver daemon on :${PORT}`);
    console.log(`  holder pubkey  ${holderPk}`);
    console.log(`  premium wallet ${holderAddress}`);
    console.log(`  tracking ${positions.length} position(s)`);
  });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pump();
    await sleep(5000);
  }
}
