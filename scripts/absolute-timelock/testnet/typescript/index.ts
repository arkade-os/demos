import {
  CLTVMultisigTapscript,
  MnemonicIdentity,
  RestArkProvider,
  VtxoScript,
  networks,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

/**
 * Only absolute timelocks (CheckLockTimeVerify) are supported within Arkade.
 * Relative timelocks (CheckSequenceVerify) are reserved for unilateral exits.
 */

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const ABSOLUTE_TIMELOCK = 1775000000n as const; // 31 March 2026

/** 1. Create user identity */
const userIdentity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
  isMainnet: false,
});

/** 2. Extract user x-only public key */
const userPubkey = await userIdentity.xOnlyPublicKey();

/** 3. Connect to operator */
const operator = new RestArkProvider(OPERATOR_URL);
const operatorInfo = await operator.getInfo();

/** 4. Extract operator x-only public key */
const operatorPubkey = hex.decode(operatorInfo.signerPubkey).slice(1);

/**
 * 5. Construct tapscript with single CLTV timelock path
 * Note: Delegate path intentionally excluded, as there is currently no mechanism for preventing the user + delegate collaborating to bypass the timelock
 */
const cltvTapscript = new VtxoScript([
  CLTVMultisigTapscript.encode({
    pubkeys: [userPubkey, operatorPubkey],
    absoluteTimelock: ABSOLUTE_TIMELOCK,
  }).script,
]);

/** 6. Log user public key, operator public key, absolute timelock, human readable date, tweaked public key, script public key, and address */
console.log({
  userPubkey: hex.encode(userPubkey),
  operatorPubkey: hex.encode(operatorPubkey),
  absoluteTimelock: ABSOLUTE_TIMELOCK,
  canSpendAfter: new Date(Number(ABSOLUTE_TIMELOCK) * 1000),
  tweakedPubKey: hex.encode(cltvTapscript.tweakedPublicKey),
  scriptPubKey: hex.encode(cltvTapscript.pkScript),
  address: cltvTapscript
    .address(networks.mutinynet.hrp, operatorPubkey)
    .encode(),
});
