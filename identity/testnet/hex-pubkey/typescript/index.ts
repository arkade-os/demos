import { ReadonlySingleKey } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const PUBLIC_KEY =
  "0255355ca83c973f1d97ce0e3843c85d78905af16b4dc531bc488e57212d230116" as const;

/** 1. Create identity */
const identity = ReadonlySingleKey.fromPublicKey(hex.decode(PUBLIC_KEY));

/** 2. Log public keys */
console.log({
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
});
