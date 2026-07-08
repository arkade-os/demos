import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const ADDRESS =
  "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameetl3ujgrw8089sl27rtp79aqcl0xspkahwnm4teg5lmhe47pxulw9m6rn8" as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider();

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
