import { ReadonlySingleKey } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { nip19 } from "nostr-tools";

const NPUB =
  "npub1q0xg5j7xfkyhhhw9l0p0vu8h4zaqkwr80ygxeufz83hut47ddlq32dd2vh5" as const;

/** 1. Decode public key from nsec */
const publicKey = nip19.decode(NPUB).data;

/** 2. Create identity */
const identity = ReadonlySingleKey.fromPublicKey(hex.decode(publicKey));

/** 3. Log public keys */
console.log({
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
});
