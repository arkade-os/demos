import {
  arkade,
  asset,
  ArkAddress,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MnemonicIdentity,
  RestArkProvider,
  RestDelegateProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  Wallet,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { EventSource } from "eventsource";

const { Arkade: ContractBuilder } = arkade;
type Program = typeof arkade.Program;

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
/** Mutinynet's "Tradeable Test Asset" (TTA) — decimals 0, the arkadeos docs' demo asset. */
const ASSET_ID =
  "623e8bc987c14f66ce6aa072585fb6b606cfd571b9c5992f99c79273348a2f8a0000" as const;

const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

const DEPOSIT_AMOUNT = 1_000n; // sats offered as the deposit
/**
 * Units of ASSET_ID demanded in return. TTA has no real market, so this is a
 * fixed rate — a solver watching BTC/TTA needs a market configured to accept
 * it (see arkade-os/solver's README: `solver market add --base BTC --quote
 * <ASSET_ID> --price-feed ..`). Without one running, funding succeeds but the
 * offer just sits unfilled until cancelled.
 */
const WANT_AMOUNT = 2n;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

(globalThis as any).EventSource = EventSource;

/**
 * Banco swap — a maker-side atomic-swap covenant. The offer vtxo can only move
 * by paying `$wantAmount` of `$wantAssetTxid`/`$wantAssetGroupIndex` to `$makerWP`
 * (`fulfill`, cosigned by the emulator once a solver's fill satisfies it), or
 * cooperatively back to the maker (`cancel`).
 */
const bancoBtcToAsset = {
  version: 0,
  params: ["makerWP", "wantAmount", "wantAssetTxid", "wantAssetGroupIndex", "server", "user"],
  functions: {
    fulfill: {
      tapscript: { signers: ["$server"] },
      arkadeScript: {
        asm: [
          0,
          "$wantAssetTxid",
          "$wantAssetGroupIndex",
          "INSPECTOUTASSETLOOKUP",
          "VERIFY",
          "$wantAmount",
          "GREATERTHANOREQUAL",
          "VERIFY",
          0,
          "INSPECTOUTPUTSCRIPTPUBKEY",
          1,
          "EQUALVERIFY",
          "$makerWP",
          "EQUAL",
        ],
      },
    },
    cancel: { tapscript: { signers: ["$user", "$server"] } },
  },
} as const satisfies Program;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
  isMainnet: false,
});

const operator = new RestArkProvider(OPERATOR_URL);
const indexer = new RestIndexerProvider(OPERATOR_URL);

const wallet = await Wallet.create({
  identity,
  arkProvider: operator,
  indexerProvider: indexer,
  delegateProvider: new RestDelegateProvider(DELEGATE_URL),
  settlementConfig: false,
  storage: {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  },
});

console.log("Starting balance:", await wallet.getBalance());

const builder = await ContractBuilder.connect({
  identity,
  arkade: operator,
  indexer,
  emulator: new RestEmulatorProvider(EMULATOR_URL),
});

/** 1. Build the swap contract: this wallet is the maker, wanting WANT_AMOUNT of ASSET_ID back. */
const wantAssetId = asset.AssetId.fromString(ASSET_ID);
const makerAddress = await wallet.getAddress();
const makerPkScript = ArkAddress.decode(makerAddress).pkScript;
const makerPublicKey = await identity.xOnlyPublicKey();

const contract = builder.contract(bancoBtcToAsset, {
  makerWP: makerPkScript.subarray(2),
  wantAmount: WANT_AMOUNT,
  // internal (little-endian) byte order, as inspected by the covenant
  wantAssetTxid: wantAssetId.txid.slice().reverse(),
  wantAssetGroupIndex: wantAssetId.groupIndex,
});

/**
 * 2. Fund the offer with BTC. The TLV extension packet (type 0x03) is the wire
 * format solvers scan funding transactions for to discover fillable offers —
 * see arkade-os/solver's swap plugin.
 */
const OFFER_PACKET_TYPE = 0x03;
const OFFER_TLV = {
  swapPkScript: 0x01,
  wantAmount: 0x02,
  wantAsset: 0x03,
  makerPkScript: 0x05,
  makerPublicKey: 0x07,
  emulatorPubkey: 0x08,
} as const;

function tlv(type: number, value: Uint8Array): Uint8Array {
  const record = new Uint8Array(3 + value.length);
  record[0] = type;
  record[1] = (value.length >> 8) & 0xff;
  record[2] = value.length & 0xff;
  record.set(value, 3);
  return record;
}

function encodeOfferPacket(): Uint8Array {
  const wantAmountBytes = new Uint8Array(8);
  new DataView(wantAmountBytes.buffer).setBigUint64(0, WANT_AMOUNT, false);
  // the emulator's key comes back 33-byte compressed; the wire format is x-only (32 bytes)
  const emulatorPubkey =
    builder.emulatorKey!.length === 33 ? builder.emulatorKey!.slice(1) : builder.emulatorKey!;
  const records = [
    tlv(OFFER_TLV.swapPkScript, contract.pkScript),
    tlv(OFFER_TLV.wantAmount, wantAmountBytes),
    tlv(OFFER_TLV.wantAsset, wantAssetId.serialize()),
    tlv(OFFER_TLV.makerPkScript, makerPkScript),
    tlv(OFFER_TLV.makerPublicKey, makerPublicKey),
    tlv(OFFER_TLV.emulatorPubkey, emulatorPubkey),
  ];
  const payload = new Uint8Array(records.reduce((sum, r) => sum + r.length, 0));
  let offset = 0;
  for (const record of records) {
    payload.set(record, offset);
    offset += record.length;
  }
  return payload;
}

const fundingTxid = await wallet.send({
  address: contract.address,
  amount: Number(DEPOSIT_AMOUNT),
  extensions: [{ type: OFFER_PACKET_TYPE, payload: encodeOfferPacket() }],
});
console.log(`Offer funded: ${EXPLORER_URL}/tx/${fundingTxid}`);

/**
 * 3. Wait for a solver to discover and fill the offer. The swap address is
 * deterministic (same params -> same script), so a repeat run could see a
 * stale spend from an earlier deposit — match on our own funding txid.
 */
const swapPkScriptHex = hex.encode(contract.pkScript);
const deadline = Date.now() + POLL_TIMEOUT_MS;
let fillTxid: string | undefined;
while (Date.now() < deadline) {
  const { vtxos } = await indexer.getVtxos({ scripts: [swapPkScriptHex], spentOnly: true });
  const spent = vtxos.find((v) => v.txid === fundingTxid && v.arkTxId);
  if (spent) {
    fillTxid = spent.arkTxId;
    break;
  }
  await sleep(POLL_INTERVAL_MS);
}
if (!fillTxid) {
  throw new Error("timed out waiting for a solver to fill the offer", {
    cause: { address: contract.address, timeoutMs: POLL_TIMEOUT_MS },
  });
}
console.log(`Swap filled: ${EXPLORER_URL}/tx/${fillTxid}`);
console.log("Final balance:", await wallet.getBalance());

await wallet.dispose();
