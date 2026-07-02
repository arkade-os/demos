import { DelegateVtxo, RestIndexerProvider } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const DELEGATED_TAPSCRIPT =
  "01c04420cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115ad208202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779cac01c028039e0440b27520cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115ac01c06620cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115ad206d7d45360014bce9a8ad30a10c28dd1571a22a2e90c9682268404d37b5b114a6ad208202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779cac" as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider();

/** 2. Decode script pubkey from tapscript */
const delegatedTapscript = DelegateVtxo.Script.decode(
  hex.decode(DELEGATED_TAPSCRIPT),
);
const scriptPubkey = hex.encode(delegatedTapscript.pkScript);

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
