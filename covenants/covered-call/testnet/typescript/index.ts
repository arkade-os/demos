/**
 * Oracle-settled covered call — end-to-end demo on Mutinynet.
 *
 * Contract: examples/options/oracle_covered_call.ark (arkade-os/compiler),
 * vendored here as covered-call.json and translated to an SDK program at
 * runtime. The writer locks BTC notional; a solver (market maker) quotes and
 * pays the premium; 3-of-5 designated oracles sign the settlement price
 * ('BTCUSD|PRICE_IN_CENTS|UNIXTIMESTAMP', digest-bound in the covenant); the
 * emulator-enforced covenant pays PH = Q·(1 − K/ST) to the holder and the
 * rest to the writer — ITM or OTM, cranked permissionlessly by either side.
 *
 * Run (three terminals):
 *   pnpm install
 *   node index.ts oracle                 # 1. price oracles      (:9010)
 *   node index.ts --daemon               # 2. solver / buyer MM  (:9011)
 *   node index.ts wallet                 # 3. writer CLI — fund the printed
 *                                        #    boarding address via
 *                                        #    https://faucet.mutinynet.com
 *   node index.ts onboard                #    …then onboard it to Arkade
 *   node index.ts market
 *   node index.ts open --notional 100000 --strike <cents> --expiry-mins 3
 *   node index.ts positions
 *   # at expiry the daemon settles automatically; force the outcome first:
 *   curl -X POST localhost:9010/price -d '{"priceCents": 130000000}'  # ITM
 *   node index.ts settle                 # manual crank (either side can)
 *   node index.ts refund                 # writer reclaim after the grace window
 *
 * The solver daemon needs its own funds for premiums: run `node index.ts
 * --daemon`, send mutinynet sats to the printed premium wallet address (or
 * onboard through the writer flow with the solver key), and restart.
 */

const cmd = process.argv.find((a, i) => i >= 2 && !a.startsWith("-"));

const HELP = `usage:
  node index.ts oracle [--spot <cents>] [--drop-oracle <i[,j]>]
  node index.ts --daemon | daemon
  node index.ts wallet | onboard | market | positions
  node index.ts open --notional <sats> --strike <cents> [--expiry-mins <m>]
  node index.ts settle [--id <quote-prefix>]
  node index.ts refund [--id <quote-prefix>]`;

if (process.argv.includes("--daemon") || cmd === "daemon") {
  const { runDaemon } = await import("./daemon.ts");
  await runDaemon();
} else if (cmd === "oracle") {
  const { runOracle } = await import("./oracle.ts");
  runOracle();
} else if (cmd === undefined || cmd === "help") {
  console.log(HELP);
} else {
  const { runWriter } = await import("./writer.ts");
  try {
    await runWriter(cmd);
    process.exit(0); // the wallet's background poller would keep the process alive
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
