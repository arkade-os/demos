import { listMarkets, quoteOffer, sideLimits } from "@arkade-os/solver-discovery";
import {
  QUOTE_OPTIONS,
  discoverMarkets,
  findMarket,
  makeCachedFeedFetch,
} from "@arkade-os/swap";

const NETWORK = "mutinynet" as const;
const REGISTRY_URL =
  "https://arkade-os.github.io/solver-registry/mutinynet.json" as const;
/** Display units of the asset we deposit, not atomic units */
const GIVE_AMOUNT = "0.001" as const;

/** 1. Discover the markets solvers advertise for this network
 * Pass `repository` (a wallet's AssetSwapRepository) for the one-hour markets
 * cache and its stale-registry fallback; omitted, this is a one-shot fetch that
 * always hits the registry.
 */
const markets = await discoverMarkets({
  network: NETWORK,
  registryUrl: REGISTRY_URL,
  logger: (...args) => console.warn(...args),
});

/** 2. An empty list is a real answer, so say which one it is
 * Discovery returns [] rather than throwing, and only some of the reasons log
 * anything: no registry URL for the network, a network string the client does
 * not recognize, a cached [] still inside its hour, or an unreachable registry
 * with nothing cached to fall back on. Mainnet, signet and regtest have no
 * listed solvers yet — there, [] is simply the truth.
 */
if (markets.length === 0) {
  throw new Error(`No markets discovered on ${NETWORK}`, {
    cause: { registryUrl: REGISTRY_URL, markets },
  });
}

/** 3. List the pairs on offer
 * `marketCount` is how many solvers quote the pair; `solvable` is how many can
 * pay each side out, so a side at 0 is a direction nobody fills.
 */
console.log(
  "pairs:",
  listMarkets(markets).map((pair) => ({
    pair: pair.pair,
    solvers: pair.marketCount,
    solvable: pair.solvable,
  })),
);

/** 4. Pick the market for the direction we want to trade
 * `findMarket` matches a pair in either orientation and reports which side we
 * deposit: `give: "base"` sends the base asset and receives the quote asset.
 */
const btcMarket = markets.find((market) => market.base_asset.id === "btc");
if (!btcMarket) {
  throw new Error("Expected a BTC market", { cause: markets });
}

const selected = findMarket(
  markets,
  btcMarket.base_asset.id,
  btcMarket.quote_asset.id,
);
if (!selected?.market) {
  throw new Error("Expected a market for the pair the registry advertises", {
    cause: btcMarket.pair,
  });
}

const { market, give } = selected;

/** 5. Read the market's per-side size limits
 * Atomic units, and both sides are bounded — a deposit outside the give side's
 * bounds is refused at fill time even though the card quoted it.
 */
console.log("market:", {
  pair: market.pair,
  solver: market.solver,
  give,
  feeBps: market.fee_bps,
  limits: {
    base: sideLimits(market, "base"),
    quote: sideLimits(market, "quote"),
  },
});

/** 6. Quote the swap
 * The card advises the pricing formula — the spot feed and the fee — and the
 * quote resolves client-side from it. Nothing is signed, no inventory is
 * reserved, and only a fill commits the solver to this swap.
 */
const plan = await quoteOffer(market, {
  give,
  giveAmount: GIVE_AMOUNT,
  ...QUOTE_OPTIONS,
  /** Short-TTL feed cache, so a debounced quote UI does not rate-limit itself */
  fetchImpl: makeCachedFeedFetch(),
});

/** 7. Log the plan
 * `plan.receive.atomic` is the `wantAmount` to register with `createOffer`, and
 * `plan.deposit` is what to send to the offer address to fund it.
 */
console.log("plan:", {
  price: plan.priceDisplay,
  deposit: `${plan.deposit.display} ${plan.deposit.asset.ticker}`,
  receive: `${plan.receive.display} ${plan.receive.asset.ticker}`,
  wantAmount: plan.receive.atomic,
  withinLimits: plan.limits.withinLimits,
});
