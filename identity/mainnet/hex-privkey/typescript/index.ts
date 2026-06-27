import { SingleKey } from "@arkade-os/sdk";
import { hex, utf8 } from "@scure/base";

const PRIVATE_KEY =
  "41f41d69260df4cf277826a9b65a3717e4eeddbeedf637f212ca096576479361" as const;

/** 1. Create identity */
const identity = SingleKey.fromHex(PRIVATE_KEY);

/** 2. Log public keys and message signature */
console.log({
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
  signature: hex.encode(
    await identity.signMessage(utf8.decode("Hello World!")),
  ),
});
