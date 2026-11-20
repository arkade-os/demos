import {
  ASSET_CARRIER_SATS,
  asset,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MnemonicIdentity,
  RestEmulatorProvider,
  submitViaEmulator,
  Transaction,
  Wallet,
} from "@arkade-os/sdk";
import { buildOfferFillPlan } from "@arkade-os/swap";
import { createOffer, fillOffer } from "@arkade-os/swap/protocol";
import { setTimeout as sleep } from "node:timers/promises";

const USER_SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const SOLVER_SEED_PHRASE =
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong" as const;
const STRANGER_SEED_PHRASE =
  "legal winner thank year wave sausage worth useful legal winner thank yellow" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

/** The user swaps ASSET_AMOUNT units of an asset it issues for PRICE_SATS sats */
const ASSET_AMOUNT = 100n;
const PRICE_SATS = 400;

const walletOf = (seedPhrase: string) =>
  Wallet.create({
    identity: MnemonicIdentity.fromMnemonic(seedPhrase, { isMainnet: false }),
    service: { operatorUrl: OPERATOR_URL },
    settlementConfig: false,
    walletMode: "static",
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  });

/** Sats the wallet can spend
 * While the wallet holds assets, this keeps back the 330 sats that carry them.
 */
const balanceOf = async (wallet: Wallet) =>
  (await wallet.getBalance()).available;

/** The wallet's outputs as fill inputs
 * `tapLeafScript` is the spending path each input takes: the one its owner
 * signs with the operator.
 */
const inputsOf = async (wallet: Wallet) =>
  (await wallet.getVtxos()).map((output) => ({
    ...output,
    tapLeafScript: output.forfeitTapLeafScript,
  }));

const fromPsbt = (psbt: string) =>
  Transaction.fromPSBT(Buffer.from(psbt, "base64"));

/** 1. Create the three wallets
 * The user funds the swap, and the solver is the one that quoted it. The
 * stranger stands for anyone else who reads the funded deposit, such as
 * another solver.
 */
const [user, solver, stranger] = await Promise.all(
  [USER_SEED_PHRASE, SOLVER_SEED_PHRASE, STRANGER_SEED_PHRASE].map(walletOf),
);
const solverKey = await solver.identity.xOnlyPublicKey();

/** 2. Fund the solver and the stranger from the user
 * Each one's fill pays the user PRICE_SATS, so each needs that much first.
 */
const short: Wallet[] = [];
for (const wallet of [solver, stranger]) {
  if ((await balanceOf(wallet)) < PRICE_SATS) short.push(wallet);
}

const needed = ASSET_CARRIER_SATS + short.length * PRICE_SATS;
const userBalance = await balanceOf(user);
if (userBalance < needed) {
  throw new Error("User wallet not funded", {
    cause: {
      address: await user.getAddress(),
      expected: needed,
      received: userBalance,
      need: needed - userBalance,
    },
  });
}

const [first, ...rest] = await Promise.all(
  short.map(async (wallet) => ({
    address: await wallet.getAddress(),
    amount: PRICE_SATS,
  })),
);
if (first) {
  await user.send(first, ...rest);
  for (const wallet of short) {
    while ((await balanceOf(wallet)) < PRICE_SATS) await sleep(1_000);
  }
}

/** 3. Issue the asset the user swaps */
const { assetId } = await user.assetManager.issue({
  amount: ASSET_AMOUNT,
  metadata: { name: "Swap demo asset", ticker: "DEMO", decimals: 0 },
});

/** 4. Create the offer with the solver's key, and fund it
 * With `taker` set, `createOffer` derives a covenant that only the solver can
 * fill: its `fulfill` path needs the solver's signature as well as the
 * operator's. If the solver doesn't fill, `cancel` returns the deposit with
 * the user's and the operator's signatures alone. In an RFQ swap, the swap
 * client derives the same covenant from the quote, with its `solver_pubkey` as
 * `taker`, and `accept()` funds it.
 *
 * The deposit is the asset on a 330-sat output. The extension carries the
 * offer's terms, so a wallet restored from its seed can find the deposit.
 */
const offer = await createOffer(user, {
  offerAsset: asset.AssetId.fromString(assetId),
  wantAmount: BigInt(PRICE_SATS),
  taker: solverKey,
});

const fundingTxid = await user.send({
  address: offer.address,
  amount: ASSET_CARRIER_SATS,
  assets: [{ assetId, amount: ASSET_AMOUNT }],
  extensions: [offer.extension],
});

console.log("Offer funded:", {
  address: offer.address,
  deposit: `${EXPLORER_URL}/tx/${fundingTxid}`,
});

/** 5. The stranger tries the same fill
 * Its transaction pays the user PRICE_SATS, so the covenant's checks pass, and
 * it signs every input it owns. The operator still refuses it, because the
 * `fulfill` path also needs the solver's signature.
 */
const plan = await buildOfferFillPlan(stranger, OPERATOR_URL, offer.offerHex, {
  fund: await inputsOf(stranger),
  fundingTxid,
});

const refusal = await submitViaEmulator(
  new RestEmulatorProvider(EMULATOR_URL),
  { arkTx: fromPsbt(plan.arkTx), checkpoints: plan.checkpoints.map(fromPsbt) },
  stranger.identity,
  {
    inputIndexes: plan.inputOwners.flatMap((owner, vin) =>
      owner === null ? [] : [vin],
    ),
  },
).then(
  () => undefined,
  (error: Error) => error,
);

const missingSignature = `missing signature for ${Buffer.from(solverKey).toString("hex")}`;
if (!refusal?.message.includes(missingSignature)) {
  throw new Error("Expected the operator to refuse the stranger's fill", {
    cause: refusal,
  });
}

console.log("Stranger's fill refused:", refusal.message);

/** 6. The solver fills the offer
 * The covenant checks the output at the deposit's own input index, so one
 * transaction could fill several deposits. `fillOffer` fills one: the deposit
 * is input 0, output 0 pays the user PRICE_SATS, and the asset goes to the
 * solver.
 */
const fillTxid = await fillOffer(solver, OPERATOR_URL, offer.offerHex, {
  fund: await inputsOf(solver),
  emulator: EMULATOR_URL,
  fundingTxid,
});

console.log("Offer filled by the solver:", `${EXPLORER_URL}/tx/${fillTxid}`);

/** 7. Graceful shutdown */
await Promise.all([user, solver, stranger].map((wallet) => wallet.dispose()));
