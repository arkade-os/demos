import { DelegateVtxo, RestIndexerProvider } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const DELEGATED_TAPSCRIPT =
  "01c0442055355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116ad20301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127aac01c02803040040b2752055355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116ac01c0662055355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116ad202903b15efe236d9609da10e536fb32cdf1d144778797bbf32a9b94e86601be6aad20301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127aac" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider(OPERATOR_URL);

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
