import {
  DefaultVtxo,
  MnemonicIdentity,
  type RelativeTimelock,
  RestArkProvider,
  networks,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;

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

/** 5. Extract operator unilateral exit timelock */
const exitTimelock = {
  value: BigInt(operatorInfo.unilateralExitDelay),
  type: "seconds",
} as const satisfies RelativeTimelock;

/** 6. Construct payment tapscript */
const PAYMENT_SCRIPT_OPTIONS = {
  pubKey: userPubkey,
  serverPubKey: operatorPubkey,
  csvTimelock: exitTimelock,
} as const satisfies DefaultVtxo.Options;

const paymentTapscript = new DefaultVtxo.Script(PAYMENT_SCRIPT_OPTIONS);

/** 7. Log user public key, operator public key, exit timelock, tweaked public key, script public key, and address */
console.log({
  userPubkey: hex.encode(userPubkey),
  operatorPubkey: hex.encode(operatorPubkey),
  exitTimelock,
  tweakedPubKey: hex.encode(paymentTapscript.tweakedPublicKey),
  scriptPubKey: hex.encode(paymentTapscript.pkScript),
  address: paymentTapscript
    .address(networks.mutinynet.hrp, operatorPubkey)
    .encode(),
});
