import {
  DefaultVtxo,
  DelegateVtxo,
  MnemonicIdentity,
  networks,
  type RelativeTimelock,
  RestArkProvider,
  RestDelegateProvider,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const DELEGATE_URL = "https://delegate.arkade.money" as const;

/** 1. Create user identity */
const userIdentity = MnemonicIdentity.fromMnemonic(SEED_PHRASE);

/** 2. Extract user x-only public key */
const userPubkey = await userIdentity.xOnlyPublicKey();

/** 3. Connect to operator */
const operator = new RestArkProvider();
const operatorInfo = await operator.getInfo();

/** 4. Extract deprecated operator x-only public keys */
const deprecatedOperatorPubkeys = operatorInfo.deprecatedSigners.map(
  ({ pubkey }) => hex.decode(pubkey).slice(1),
);

/** 5. Extract operator unilateral + boarding exit timelocks */
const unilateralExitTimelock = {
  value: BigInt(operatorInfo.unilateralExitDelay),
  type: "seconds",
} as const satisfies RelativeTimelock;

const boardingExitTimelock = {
  value: BigInt(operatorInfo.boardingExitDelay),
  type: "seconds",
} as const satisfies RelativeTimelock;

/** 6. Connect to delegate */
const delegate = new RestDelegateProvider(DELEGATE_URL);
const delegateInfo = await delegate.getDelegateInfo();

/** 7. Extract delegate x-only public key */
const delegatePubkey = hex.decode(delegateInfo.pubkey).slice(1);

/** 8. Construct default + delegated + boarding tapscripts for each deprecated signer */
const deprecatedTapscripts = deprecatedOperatorPubkeys.map((operatorPubkey) => {
  const paymentTapscript = new DefaultVtxo.Script({
    pubKey: userPubkey,
    serverPubKey: operatorPubkey,
    csvTimelock: unilateralExitTimelock,
  });
  const delegatedTapscript = new DelegateVtxo.Script({
    pubKey: userPubkey,
    serverPubKey: operatorPubkey,
    delegatePubKey: delegatePubkey,
    csvTimelock: unilateralExitTimelock,
  });
  const boardingTapscript = new DefaultVtxo.Script({
    pubKey: userPubkey,
    serverPubKey: operatorPubkey,
    csvTimelock: boardingExitTimelock,
  });
  return {
    operatorPubkey,
    paymentTapscript,
    delegatedTapscript,
    boardingTapscript,
  } as const;
});

/** 9. Log user public key, operator public key, delegate pubkey (if applicable), exit timelock, tweaked public key, script public key, and address for each deprecated tapscript */
console.log(
  deprecatedTapscripts.flatMap(
    ({
      operatorPubkey,
      paymentTapscript,
      delegatedTapscript,
      boardingTapscript,
    }) => [
      {
        userPubkey: hex.encode(userPubkey),
        operatorPubkey: hex.encode(operatorPubkey),
        exitTimelock: unilateralExitTimelock,
        tweakedPubKey: hex.encode(paymentTapscript.tweakedPublicKey),
        scriptPubKey: hex.encode(paymentTapscript.pkScript),
        address: paymentTapscript.address(undefined, operatorPubkey).encode(),
      },
      {
        userPubkey: hex.encode(userPubkey),
        operatorPubkey: hex.encode(operatorPubkey),
        delegatePubkey: hex.encode(delegatePubkey),
        exitTimelock: unilateralExitTimelock,
        tweakedPubKey: hex.encode(delegatedTapscript.tweakedPublicKey),
        scriptPubKey: hex.encode(delegatedTapscript.pkScript),
        address: delegatedTapscript.address(undefined, operatorPubkey).encode(),
      },
      {
        userPubkey: hex.encode(userPubkey),
        operatorPubkey: hex.encode(operatorPubkey),
        exitTimelock: boardingExitTimelock,
        tweakedPubKey: hex.encode(boardingTapscript.tweakedPublicKey),
        scriptPubKey: hex.encode(boardingTapscript.pkScript),
        address: boardingTapscript.onchainAddress(networks.bitcoin),
      },
    ],
  ),
);
