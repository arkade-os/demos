import { DelegateVtxo, RestArkProvider } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const DELEGATED_TAPSCRIPT =
  "01c04420cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115ad208202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779cac01c028039e0440b27520cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115ac01c06620cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115ad206d7d45360014bce9a8ad30a10c28dd1571a22a2e90c9682268404d37b5b114a6ad208202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779cac" as const;

/** 1. Decode tapscript */
const delegatedTapscript = DelegateVtxo.Script.decode(
  hex.decode(DELEGATED_TAPSCRIPT),
);

/** 2. Fetch operator public key */
const { signerPubkey } = await new RestArkProvider().getInfo();
const operatorPubkey = hex.decode(signerPubkey).slice(1);

/** 3. Encode as address */
const address = delegatedTapscript.address(undefined, operatorPubkey);

/** 4. Log address information */
console.log({
  hrp: address.hrp,
  version: address.version,
  operatorPubkey: hex.encode(address.serverPubKey),
  scriptPubkey: hex.encode(address.pkScript),
  subdustScriptPubkey: hex.encode(address.subdustPkScript),
  taprootOutputKey: hex.encode(address.vtxoTaprootKey),
});
