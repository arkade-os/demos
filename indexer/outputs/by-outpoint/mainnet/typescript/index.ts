import { RestIndexerProvider } from "@arkade-os/sdk";

const OUTPOINT = {
  txid: "1fb46df31e90f6e660276f2b9769e70d650fcb828aa5286f2a8deb890ac4e5b4",
  vout: 1,
} as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider();

/** 2. Fetch outpoint */
const { vtxos: outputs } = await indexer.getVtxos({
  outpoints: [OUTPOINT],
});

/** 3. Log outputs (map to basic details) */
console.log(
  outputs.map(({ txid, vout, value, virtualStatus: { state: status } }) => ({
    txid,
    vout,
    value,
    status,
  })),
);
