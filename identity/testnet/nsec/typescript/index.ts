import { SingleKey } from "@arkade-os/sdk";
import { hex, utf8 } from "@scure/base";
import { nip19 } from "nostr-tools";

const NSEC =
  "nsec1mlcu3skqz6jh9y2tf3ddhpu36c45w69wn59xr052h9x02qud0kgqzzc38h" as const;

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
