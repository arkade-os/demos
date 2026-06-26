import { ReadonlySingleKey } from "@arkade-os/sdk";
import { hex } from "@scure/base";

const PUBLIC_KEY =
  "03cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115" as const;

/** 1. Create identity */
const identity = ReadonlySingleKey.fromPublicKey(hex.decode(PUBLIC_KEY));

/** 2. Log public keys */
console.log({
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
});
