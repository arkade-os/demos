import { SeedIdentity, type SeedIdentityOptions } from "@arkade-os/sdk";
import { hex, utf8 } from "@scure/base";

const SEED =
  "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4" as const;
const FINGERPRINT = "73c5da0a" as const; // Master key fingerprint derived from SEED
const PURPOSE = "86'" as const; // Taproot
const COIN_TYPE = "0'" as const; // Mainnet
const ACCOUNT = "0'" as const; // Account #0
const XPUB =
  "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ" as const; // xpub derived from SEED at m/86'/0'/0'
const CHANGE_INDEX = "0" as const; // Change #0 (deposit)

const DEFAULT_OPTIONS = {
  isMainnet: true,
  descriptor: `tr([${FINGERPRINT}/${PURPOSE}/${COIN_TYPE}/${ACCOUNT}]${XPUB}/${CHANGE_INDEX}/*)`,
} as const satisfies SeedIdentityOptions;

/** 1. Create identity with explicit default options */
const identity = SeedIdentity.fromSeed(hex.decode(SEED), DEFAULT_OPTIONS);

/** 2. Log descriptor, public keys, and message signature */
console.log({
  descriptor: identity.descriptor,
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
  signature: hex.encode(
    await identity.signMessage(utf8.decode("Hello World!")),
  ),
});
