import {
  CSVMultisigTapscript,
  MnemonicIdentity,
  MultisigTapscript,
  networks,
  RestArkProvider,
  VtxoScript,
  type RelativeTimelock,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const BACKUP_SEED_PHRASE =
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;

/** 1. Create user and backup identities */
const userIdentity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
  isMainnet: false,
});
const backupIdentity = MnemonicIdentity.fromMnemonic(BACKUP_SEED_PHRASE, {
  isMainnet: false,
});

/** 2. Extract user and backup x-only public keys */
const userPubkey = await userIdentity.xOnlyPublicKey();
const backupPubkey = await backupIdentity.xOnlyPublicKey();

/** 3. Connect to operator */
const operator = new RestArkProvider(OPERATOR_URL);
const operatorInfo = await operator.getInfo();

/** 4. Extract operator x-only public key */
const operatorPubkey = hex.decode(operatorInfo.signerPubkey).slice(1);

/**
 * 5. Extract operator boarding exit timelock, and double it for recovery
 *
 * The operator only accepts a boarding output if its shortest exit delay is
 * at least boardingExitDelay. Offchain scripts use unilateralExitDelay instead.
 */
const exitTimelock = {
  value: BigInt(operatorInfo.boardingExitDelay),
  type: "seconds",
} as const satisfies RelativeTimelock;
const recoveryTimelock = {
  value: exitTimelock.value * 2n,
  type: "seconds",
} as const satisfies RelativeTimelock;

/**
 * 6. Construct custom boarding tapscript
 *
 * The operator accepts any script in which every path without a CSV delay
 * includes the operator's key. This script has no delegate path, and the
 * operator doesn't require one.
 */
const customBoardingTapscript = new VtxoScript([
  // user + operator (boarding spends this path)
  MultisigTapscript.encode({
    pubkeys: [userPubkey, operatorPubkey],
  }).script,
  // user alone, after the boarding exit delay (unilateral exit)
  CSVMultisigTapscript.encode({
    pubkeys: [userPubkey],
    timelock: exitTimelock,
  }).script,
  // backup key alone, after twice the boarding exit delay (recovery)
  CSVMultisigTapscript.encode({
    pubkeys: [backupPubkey],
    timelock: recoveryTimelock,
  }).script,
]);

/** 7. Log user public key, backup public key, operator public key, exit and recovery timelocks, tweaked public key, script public key, and onchain address */
console.log({
  userPubkey: hex.encode(userPubkey),
  backupPubkey: hex.encode(backupPubkey),
  operatorPubkey: hex.encode(operatorPubkey),
  exitTimelock,
  recoveryTimelock,
  tweakedPubKey: hex.encode(customBoardingTapscript.tweakedPublicKey),
  scriptPubKey: hex.encode(customBoardingTapscript.pkScript),
  address: customBoardingTapscript.onchainAddress(networks.mutinynet),
});
