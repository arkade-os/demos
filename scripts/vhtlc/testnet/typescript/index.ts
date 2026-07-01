import {
  MnemonicIdentity,
  networks,
  RestArkProvider,
  VHTLC,
  type RelativeTimelock,
} from "@arkade-os/sdk";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

const ALICE_SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const BOB_SEED_PHRASE =
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const PREIMAGE =
  "c860df09616fa70b534e555fc42da51bb809b3eb524b75c002b4a92a931f1fb3" as const;
const REFUND_LOCKTIME = 1775000000n as const; // 31 March 2026

/** 1. Create sender + receiver identities */
const senderIdentity = MnemonicIdentity.fromMnemonic(ALICE_SEED_PHRASE, {
  isMainnet: false,
});
const receiverIdentity = MnemonicIdentity.fromMnemonic(BOB_SEED_PHRASE, {
  isMainnet: false,
});

/** 2. Extract sender + receiver x-only public keys */
const senderPubkey = await senderIdentity.xOnlyPublicKey();
const receiverPubkey = await receiverIdentity.xOnlyPublicKey();

/** 3. Connect to operator */
const operator = new RestArkProvider(OPERATOR_URL);
const operatorInfo = await operator.getInfo();

/** 4. Extract operator x-only public key */
const operatorPubkey = hex.decode(operatorInfo.signerPubkey).slice(1);

/** 5. Construct unilateral delays */
const [
  unilateralClaimDelay,
  unilateralRefundDelay,
  unilateralRefundWithoutReceiverDelay,
] = [
  {
    value: BigInt(operatorInfo.unilateralExitDelay) + 512n,
    type: "seconds",
  },
  {
    value: BigInt(operatorInfo.unilateralExitDelay) + 1024n,
    type: "seconds",
  },
  {
    value: BigInt(operatorInfo.unilateralExitDelay) + 1536n,
    type: "seconds",
  },
] as const satisfies Array<RelativeTimelock>;

/** 6. Derive preimage hash */
const preimageHash = ripemd160(sha256(hex.decode(PREIMAGE)));

/** 7. Construct VHTLC tapscript */
const VHTLC_SCRIPT_OPTIONS = {
  sender: senderPubkey,
  receiver: receiverPubkey,
  server: operatorPubkey,
  preimageHash,
  refundLocktime: REFUND_LOCKTIME,
  unilateralClaimDelay,
  unilateralRefundDelay,
  unilateralRefundWithoutReceiverDelay,
} as const satisfies VHTLC.Options;

const vhtlcTapscript = new VHTLC.Script(VHTLC_SCRIPT_OPTIONS);

/** 8. Log user public key, operator public key, exit timelocks, preimage hash, refund locktime, tweaked public key, script public key, and address */
console.log({
  senderPubkey: hex.encode(senderPubkey),
  receiverPubkey: hex.encode(receiverPubkey),
  operatorPubkey: hex.encode(operatorPubkey),
  unilateralClaimDelay,
  unilateralRefundDelay,
  unilateralRefundWithoutReceiverDelay,
  preimageHash: hex.encode(preimageHash),
  refundLocktime: REFUND_LOCKTIME,
  tweakedPubKey: hex.encode(vhtlcTapscript.tweakedPublicKey),
  scriptPubKey: hex.encode(vhtlcTapscript.pkScript),
  address: vhtlcTapscript
    .address(networks.mutinynet.hrp, operatorPubkey)
    .encode(),
});
