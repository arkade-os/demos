import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const ADDRESS =
  "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84fv7fwu6sqrrdnjqlnqu59lq0nvzzu0d8usv7xjvcpyzt35whucrkca56d" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider(OPERATOR_URL);

/** 2. Extract script from Arkade address */
const address = ArkAddress.decode(ADDRESS);
const scriptPubkey = hex.encode(address.pkScript);

/** 3. Fetch spendable outputs */
const { vtxos: outputs } = await indexer.getVtxos({
  /** Fetch for the script pubkey */
  scripts: [scriptPubkey],
  /** Only include spendable outputs */
  spendableOnly: true,
});

/** 4. Log spendable outputs (map to basic details) */
console.log(
  outputs.map(({ txid, vout, value, virtualStatus: { state: status } }) => ({
    txid,
    vout,
    value,
    status,
  })),
);
