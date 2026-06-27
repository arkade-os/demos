import { SingleKey } from "@arkade-os/sdk";
import { hex, utf8 } from "@scure/base";
import { nip19 } from "nostr-tools";

const NSEC =
  "nsec1g86p66fxph6v7fmcy65mvk3hzljwahd7ahmr0usjegyk2aj8jdssxcrwds" as const;

/** 1. Decode private key from nsec */
const privateKey = nip19.decode(NSEC).data;

/** 2. Create identity */
const identity = SingleKey.fromPrivateKey(privateKey);

/** 3. Log public keys and message signature */
console.log({
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
  signature: hex.encode(
    await identity.signMessage(utf8.decode("Hello World!")),
  ),
});
