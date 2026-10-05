/**
 * Writer CLI — the option WRITER (seller) side: a wallet to onboard BTC,
 * request quotes, fund the covered-call vault, receive the premium, and
 * eventually crank settlement or reclaim the collateral.
 *
 * Trust model at `open`: the writer builds the FULL parameter set itself —
 * its own keys and payout script, the oracle set fetched straight from the
 * oracle service (never from the solver), and the quoted terms — derives the
 * vault address locally, and only funds if the solver derives the exact same
 * address. Nothing solver-supplied can redirect the writer's collateral.
 */

import { hex } from "@scure/base";
import { Ramps } from "@arkade-os/sdk";
import {
  arg,
  connectArkade,
  deriveContract,
  EXPLORER_URL,
  fmtSats,
  fmtUsd,
  getJSON,
  loadState,
  now,
  ORACLE_URL,
  pickAttestations,
  postJSON,
  programOfAddress,
  p2trScript,
  saveState,
  settleContract,
  sleep,
  SOLVER_URL,
  type CCParams,
  type PriceTick,
} from "./contract.ts";
import { openWallet, waitForFunds } from "./wallet.ts";

type WriterPosition = {
  quoteId: string;
  params: CCParams;
  address: string;
  premiumSats: number;
  state: "funded" | "settled" | "refunded";
  settlement?: { txid: string; st: number; holderSats: number; writerSats: number };
};

const positions = () => loadState("writer-positions", [] as WriterPosition[]);
const persist = (p: WriterPosition[]) => saveState("writer-positions", p);

export async function runWriter(command: string) {
  const { identity, wallet } = await openWallet("writer");

  switch (command) {
    case "wallet": {
      const balance = await wallet.getBalance();
      console.log("writer wallet");
      console.log(`  ark address      ${await wallet.getAddress()}`);
      console.log(`  boarding address ${await wallet.getBoardingAddress()}`);
      console.log(`  available        ${fmtSats(balance.available)}`);
      console.log(`  boarding         ${fmtSats(balance.boarding.total)} (fund via https://faucet.mutinynet.com, then run: onboard)`);
      return;
    }

    case "onboard": {
      const { fees } = await wallet.arkProvider.getInfo();
      const txid = await new Ramps(wallet).onboard(fees);
      console.log(`onboarded: ${txid}`);
      console.log(`  available now ${fmtSats((await wallet.getBalance()).available)}`);
      return;
    }

    case "market": {
      const info = await getJSON<any>(`${SOLVER_URL}/info`);
      const price = await getJSON<PriceTick>(`${ORACLE_URL}/price`);
      console.log(`oracle:  ${price.display}  (${fmtUsd(price.priceCents)})`);
      console.log(`solver:  spot ${fmtUsd(info.spotCents)}`);
      console.log(`  strikes   ${info.strikes.map((s: number) => fmtUsd(s)).join("  ")}`);
      console.log(`  notional  ${fmtSats(info.notional.min)} .. ${fmtSats(info.notional.max)}`);
      console.log(`  terms     grace ${info.terms.grace}s, coopExit ${info.terms.coopExit} blocks, exit ${info.terms.exit} blocks`);
      return;
    }

    case "open": {
      const notional = Number(arg("--notional") ?? 100_000);
      const strike = Number(arg("--strike") ?? 0);
      const expiryMins = Number(arg("--expiry-mins") ?? 3);
      const expiry = now() + Math.round(expiryMins * 60);

      const funds = BigInt((await wallet.getBalance()).available);
      if (funds < BigInt(notional)) {
        throw new Error(
          `insufficient funds: have ${fmtSats(funds)}, need ${fmtSats(notional)} — fund via https://faucet.mutinynet.com, then run: onboard`,
        );
      }

      /** 1. Quote. */
      const quote = await postJSON<any>(`${SOLVER_URL}/rfq`, { notional, strike, expiry });
      console.log(
        `quote ${quote.quoteId}\n  premium ${fmtSats(quote.premiumSats)} for ${fmtSats(notional)} @ K=${fmtUsd(strike)}, expiry in ${expiryMins}m`,
      );

      /** 2. Build the parameter set from OUR OWN view of every field. */
      const oracle = await getJSON<any>(`${ORACLE_URL}/info`);
      if (oracle.oracles.length !== 5) throw new Error("oracle service must expose 5 oracles");
      const writerPk = hex.encode(await identity.xOnlyPublicKey());
      const writerAddress = await wallet.getAddress();
      const params: CCParams = {
        writerPk,
        holderPk: quote.holderPk,
        writerScript: hex.encode(programOfAddress(writerAddress)),
        holderScript: quote.holderScript,
        oracles: oracle.oracles,
        tickerHash: oracle.tickerHash,
        strike,
        expiry,
        priceWindow: oracle.priceWindow,
        refundAt: expiry + quote.terms.grace,
        notional,
        coopExit: quote.terms.coopExit,
        exit: quote.terms.exit,
      };
      if (params.refundAt <= params.expiry + params.priceWindow) {
        throw new Error("unsafe terms: refund window would overlap the price window");
      }
      // Cap solver-quoted timelocks: excessive values cannot redirect the
      // collateral, but they could freeze the writer's refund and exit
      // fallbacks far into the future.
      if (quote.terms.grace > 86_400) {
        throw new Error(`unsafe terms: grace ${quote.terms.grace}s exceeds 24h`);
      }
      if (quote.terms.coopExit < 1 || quote.terms.coopExit > 4_320) {
        throw new Error(`unsafe terms: coopExit ${quote.terms.coopExit} blocks out of range`);
      }
      if (quote.terms.exit < 1 || quote.terms.exit > 4_320) {
        throw new Error(`unsafe terms: exit ${quote.terms.exit} blocks out of range`);
      }

      /** 3. Derive the vault address locally, then require the solver to agree. */
      const client = await connectArkade(identity);
      const address = deriveContract(client, params).address;
      const accepted = await postJSON<any>(`${SOLVER_URL}/accept`, {
        quoteId: quote.quoteId,
        writerPk,
        writerScript: params.writerScript,
        writerAddress,
        params,
      });
      if (accepted.contractAddress !== address) {
        throw new Error(
          `solver derived a different vault address (${accepted.contractAddress} != ${address}) — aborting before funding`,
        );
      }

      /** 4. Lock the notional (spec order: user locks Q, solver then pays V). */
      const baseline = funds;
      const fundTxid = await wallet.send({ address, amount: notional });
      console.log(`vault funded with ${fmtSats(notional)}: ${EXPLORER_URL}/tx/${fundTxid}`);
      console.log(`  vault ${address}`);

      const all = positions();
      all.push({
        quoteId: quote.quoteId,
        params,
        address,
        premiumSats: quote.premiumSats,
        state: "funded",
      });
      persist(all);

      /** 5. Wait for the premium to arrive. */
      console.log("waiting for premium...");
      await waitForFunds(wallet, baseline - BigInt(notional), BigInt(quote.premiumSats), 120);
      console.log(`premium received: ${fmtSats(quote.premiumSats)}`);
      console.log(`position open — settlement at ${new Date(expiry * 1000).toISOString()}`);
      return;
    }

    case "positions": {
      const all = positions();
      if (all.length === 0) return console.log("no positions");
      const client = await connectArkade(identity);
      const price = await getJSON<PriceTick>(`${ORACLE_URL}/price`).catch(() => null);
      for (const p of all) {
        const vault = await deriveContract(client, p.params).getUtxos();
        const t = now();
        const phase =
          p.state !== "funded"
            ? p.state
            : vault.length === 0
              ? "closed (settled or refunded)"
              : t < p.params.expiry
                ? `live, expires in ${p.params.expiry - t}s`
                : t < p.params.refundAt
                  ? "expired — settlement window"
                  : "refundable";
        console.log(`${p.quoteId}`);
        console.log(`  vault    ${p.address} (${vault.length} vtxo)`);
        console.log(`  terms    ${fmtSats(p.params.notional)} @ K=${fmtUsd(p.params.strike)}, premium ${fmtSats(p.premiumSats)}`);
        if (price) {
          const itm = price.priceCents > p.params.strike;
          console.log(`  spot     ${fmtUsd(price.priceCents)} (${itm ? "ITM" : "OTM"})`);
        }
        console.log(`  status   ${phase}`);
        if (p.settlement) {
          console.log(
            `  settled  ST=${fmtUsd(p.settlement.st)} holder ${fmtSats(p.settlement.holderSats)} / writer ${fmtSats(p.settlement.writerSats)} (${p.settlement.txid})`,
          );
        }
      }
      return;
    }

    case "settle": {
      /** Permissionless crank from the writer side (e.g. the solver is down). */
      const p = findPosition();
      if (now() < p.params.expiry) {
        throw new Error(`not expired yet (${p.params.expiry - now()}s to go)`);
      }
      const client = await connectArkade(identity);
      const ticks = await getJSON<PriceTick[]>(
        `${ORACLE_URL}/attestations?from=${p.params.expiry - p.params.priceWindow}&to=${p.params.expiry}`,
      );
      const picks = pickAttestations(ticks, p.params.oracles, p.params.expiry, p.params.priceWindow);
      const result = await settleContract(client, p.params, picks);
      updatePosition(p.quoteId, {
        state: "settled",
        settlement: {
          txid: result.txid,
          st: Number(result.st),
          holderSats: Number(result.holderSats),
          writerSats: Number(result.writerSats),
        },
      });
      console.log(
        `settled at ST=${fmtUsd(Number(result.st))} — holder ${fmtSats(result.holderSats)}, writer ${fmtSats(result.writerSats)}`,
      );
      console.log(`  ${EXPLORER_URL}/tx/${result.txid}`);
      return;
    }

    case "refund": {
      /** Writer + operator reclaim after refundAt (CLTV leaf, no covenant). */
      const p = findPosition();
      if (now() < p.params.refundAt) {
        throw new Error(`refund opens at ${p.params.refundAt} (${p.params.refundAt - now()}s to go)`);
      }
      const client = await connectArkade(identity);
      const contract = deriveContract(client, p.params);
      const vault = await contract.getUtxos();
      if (vault.length === 0) throw new Error("vault already spent (settled?)");
      const coin = vault[0];
      const { txid } = await contract.functions
        .refund()
        .from(coin)
        .to(p2trScript(hex.decode(p.params.writerScript)), BigInt(coin.value))
        .send();
      updatePosition(p.quoteId, { state: "refunded" });
      console.log(`collateral reclaimed: ${EXPLORER_URL}/tx/${txid}`);
      return;
    }

    default:
      throw new Error(`unknown command '${command}' — run: node index.ts help`);
  }

  function findPosition(): WriterPosition {
    const all = positions();
    const id = arg("--id");
    const p = id ? all.find((x) => x.quoteId.startsWith(id)) : all[all.length - 1];
    if (!p) throw new Error(id ? `no position matching '${id}'` : "no positions");
    return p;
  }

  function updatePosition(quoteId: string, patch: Partial<WriterPosition>) {
    const all = positions();
    const i = all.findIndex((x) => x.quoteId === quoteId);
    if (i !== -1) {
      all[i] = { ...all[i], ...patch };
      persist(all);
    }
  }
}

/** Poll helper used by `open` to report premium arrival (re-exported for tests). */
export { waitForFunds };
