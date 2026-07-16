import { DelegateVtxo, RestArkProvider, networks } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const DELEGATED_TAPSCRIPT =
  "01c0442055355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116ad20301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127aac01c02803040040b2752055355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116ac01c0662055355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116ad202903b15efe236d9609da10e536fb32cdf1d144778797bbf32a9b94e86601be6aad20301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127aac" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;

/** 1. Decode tapscript */
const delegatedTapscript = DelegateVtxo.Script.decode(
  hex.decode(DELEGATED_TAPSCRIPT),
);

/** 2. Fetch operator public key */
const { signerPubkey } = await new RestArkProvider(OPERATOR_URL).getInfo();
const operatorPubkey = hex.decode(signerPubkey).slice(1);

/** 3. Encode as address */
const address = delegatedTapscript.address(
  networks.mutinynet.hrp,
  operatorPubkey,
);

/** 4. Log address information */
console.log({
  hrp: address.hrp,
  version: address.version,
  operatorPubkey: hex.encode(address.serverPubKey),
  scriptPubkey: hex.encode(address.pkScript),
  subdustScriptPubkey: hex.encode(address.subdustPkScript),
  taprootOutputKey: hex.encode(address.vtxoTaprootKey),
});
