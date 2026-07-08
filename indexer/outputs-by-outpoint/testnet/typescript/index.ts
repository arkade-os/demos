import { RestIndexerProvider } from "@arkade-os/sdk";

const OUTPOINT = {
  txid: "6445acfc889873dedf9512c63518010a89d004882ba681d905519fabf21889f0",
  vout: 0,
} as const;

const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider(OPERATOR_URL);

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
