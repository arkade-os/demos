import { MnemonicIdentity, type MnemonicOptions } from "@arkade-os/sdk";
import { hex, utf8 } from "@scure/base";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const FINGERPRINT = "73c5da0a" as const; // Master key fingerprint derived from SEED_PHRASE
const PURPOSE = "86'" as const; // Taproot
const COIN_TYPE = "0'" as const; // Mainnet
const ACCOUNT = "0'" as const; // Account #0
const XPUB =
  "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ" as const; // xpub derived from SEED_PHRASE at m/86'/0'/0'
const CHANGE_INDEX = "0" as const; // Change #0 (deposit)

const DEFAULT_OPTIONS = {
  isMainnet: true,
  passphrase: "",
  descriptor: `tr([${FINGERPRINT}/${PURPOSE}/${COIN_TYPE}/${ACCOUNT}]${XPUB}/${CHANGE_INDEX}/*)`,
} as const satisfies MnemonicOptions;

/** 1. Create identity with explicit default options */
const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, DEFAULT_OPTIONS);

/** 2. Log descriptor, public keys, and message signature */
console.log({
  descriptor: identity.descriptor,
  compressedPublicKey: hex.encode(await identity.compressedPublicKey()),
  xOnlyPublicKey: hex.encode(await identity.xOnlyPublicKey()),
  signature: hex.encode(
    await identity.signMessage(utf8.decode("Hello World!")),
  ),
});
