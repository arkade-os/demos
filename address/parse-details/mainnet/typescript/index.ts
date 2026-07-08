import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const ADDRESS =
  "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameetl3ujgrw8089sl27rtp79aqcl0xspkahwnm4teg5lmhe47pxulw9m6rn8" as const;

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
