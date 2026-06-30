import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const ADDRESS =
  "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84fv7fwu6sqrrdnjqlnqu59lq0nvzzu0d8usv7xjvcpyzt35whucrkca56d" as const;

/** 1. Parse as Arkade address */
const address = ArkAddress.decode(ADDRESS);

/** 2. Log address information, including:
 * - Human-readable prefix (tark)
 * - Version (0)
 * - Operator public key (x-only)
 * - Script public key (Taproot output key prepended by OP_1)
 * - Subdust script public key (Taproot output key prepended by OP_RETURN)
 * - Taproot output key a.k.a. tweaked public key
 */
console.log({
  hrp: address.hrp,
  version: address.version,
  operatorPubkey: hex.encode(address.serverPubKey),
  scriptPubkey: hex.encode(address.pkScript),
  subdustScriptPubkey: hex.encode(address.subdustPkScript),
  taprootOutputKey: hex.encode(address.vtxoTaprootKey),
});
