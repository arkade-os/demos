/** WIP: needs cleanup */

import {
  ArkAddress,
  DelegateVtxo,
  isRecoverable,
  MnemonicIdentity,
  networks,
  P2A,
  RestArkProvider,
  RestDelegateProvider,
  Transaction,
  Wallet,
} from "@arkade-os/sdk";
import {
  SQLiteContractRepository,
  SQLiteWalletRepository,
  type SQLExecutor,
} from "@arkade-os/sdk/repositories/sqlite";
import { base64, hex } from "@scure/base";
import { Address, OutScript, SigHash } from "@scure/btc-signer";
import type { TransactionOutput } from "@scure/btc-signer/psbt.js";
import Database from "better-sqlite3";
import { EventSource } from "eventsource";

/** from faucet.mutinynet.com */
const ONCHAIN_ADDRESS = "tb1qmt3ue2senlg6ddgmr76hwsk0rdvdk4rgeaen7l" as const;
const ONCHAIN_AMOUNT = 10_000n as const;

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const DELEGATE_URL = "https://delegator.mutinynet.arkade.sh" as const;
const NETWORK = networks.mutinynet;

/** 1. Polyfill EventSource
 * EventSource is used internally by the SDK for settlement events (SSE).
 * It is not available in Node.js by default, so we need to polyfill it.
 */
(globalThis as any).EventSource = EventSource;

/** 2. Initialize SQLite database */
const initDB = (dbPath: string) => {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  const sqlExecutor = {
    run: async (sql, params) => {
      db.prepare(sql).run(...(params ?? []));
    },
    get: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...(params ?? [])) as T | undefined,
    all: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...(params ?? [])) as T[],
  } as const satisfies SQLExecutor;
  const closeDB = () => db.close();
  return { sqlExecutor, closeDB };
};
const { sqlExecutor, closeDB } = initDB("wallet.sqlite");

/** 3. Verify `ONCHAIN_ADDRESS` */
let onchainPkScript: Uint8Array<ArrayBufferLike> | undefined;
try {
  onchainPkScript = OutScript.encode(Address(NETWORK).decode(ONCHAIN_ADDRESS)!);
} catch (_error) {
  throw new Error("Invalid ONCHAIN_ADDRESS", {
    cause: ONCHAIN_ADDRESS,
  });
}

/** 4. Create identity */
const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
  isMainnet: false,
});

/** 5. Create Arkade provider and get info */
const operator = new RestArkProvider(OPERATOR_URL);
const operatorInfo = await operator.getInfo();

/** 6. Create delegate provider and get info */
const delegate = new RestDelegateProvider(DELEGATE_URL);
const delegateInfo = await delegate.getDelegateInfo();

/** 7. Create wallet */
const wallet = await Wallet.create({
  identity,
  arkProvider: operator,
  delegateProvider: delegate,
  /**
   * Explicitly disable settlement
   * Recommended to leave undefined for production
   */
  settlementConfig: false,
  /**
   * Explicitly disable address rotation
   * Recommended to use 'hd' for production
   */
  walletMode: "static",
  /**
   * Explicitly use SQLite storage
   * Defaults to IndexedDB if undefined
   */
  storage: {
    walletRepository: new SQLiteWalletRepository(sqlExecutor),
    contractRepository: new SQLiteContractRepository(sqlExecutor),
  },
});

/** 8. Fetch delegable inputs */
const contractManager = await wallet.getContractManager();
const contractsWithOutputs = await contractManager.getContractsWithVtxos({
  /** Filter only for current delegated script */
  script: hex.encode(wallet.arkAddress.pkScript),
  /** Filter only for scripts with delegate path */
  type: "delegate",
});
/** Filter out spent or unrolled outputs */
const delegableInputs = contractsWithOutputs
  .flatMap(({ vtxos }) => vtxos)
  .filter((output) => !(output.isSpent || output.isUnrolled));

/** 9. Verify outputs cover fees */
const inputTotal = delegableInputs.reduce(
  (sum, input) => sum + BigInt(input.value),
  0n,
);
const delegateFee = BigInt(delegateInfo.fee);
const intentFees =
  /** Offchain input fees */
  BigInt(Number(operatorInfo.fees.intentFee.offchainInput || 0)) *
    BigInt(delegableInputs.length) +
  /** Onchain exit fee */
  BigInt(Number(operatorInfo.fees.intentFee.onchainOutput || 0)) +
  /** Offchain change fee */
  BigInt(Number(operatorInfo.fees.intentFee.offchainOutput || 0));
const minimumInputTotal = ONCHAIN_AMOUNT + delegateFee + intentFees;

if (inputTotal < minimumInputTotal) {
  throw new Error("Insufficient funds for delegated exit", {
    cause: {
      available: inputTotal,
      required: minimumInputTotal,
      exitAmount: ONCHAIN_AMOUNT,
      delegateFee,
      intentFees,
      address: wallet.arkAddress.encode(),
    },
  });
}

/** 10. Construct desired outputs */
const outputs = [
  /** Exit output */
  {
    script: onchainPkScript,
    amount: ONCHAIN_AMOUNT,
  },
  /** Change output */
  {
    script: wallet.arkAddress.pkScript,
    amount: inputTotal - ONCHAIN_AMOUNT - delegateFee - intentFees,
  },
] as const satisfies TransactionOutput[];
if (BigInt(delegateInfo.fee) > 0n) {
  /** Delegate fee */
  outputs.push({
    script: ArkAddress.decode(delegateInfo.delegateAddress).pkScript,
    amount: delegateFee,
  });
}

/** 6. Construct signed delegation intent */
const signedIntent = await wallet.makeRegisterIntentSignature(
  delegableInputs,
  outputs,
  /** Put output #0 onchain */
  [0],
  [delegateInfo.pubkey],
  /** Delegate immediately */
  Math.floor(Date.now() / 1000),
);

/** 7. Construct forfeit transactions */
const delegatedScript = new DelegateVtxo.Script({
  pubKey: await identity.xOnlyPublicKey(),
  serverPubKey: hex.decode(operatorInfo.signerPubkey).slice(1),
  delegatePubKey: hex.decode(delegateInfo.pubkey).slice(1),
  csvTimelock: {
    value: BigInt(operatorInfo.unilateralExitDelay),
    type: "seconds",
  },
});

if (
  hex.encode(delegatedScript.pkScript) !==
  hex.encode(wallet.arkAddress.pkScript)
) {
  throw new Error("Could not construct delegated tapscript", {
    cause: {
      expected: hex.encode(wallet.arkAddress.pkScript),
      received: hex.encode(delegatedScript.pkScript),
    },
  });
}

const forfeitTxs = await Promise.all(
  delegableInputs
    .filter((input) => !isRecoverable(input))
    .map(async (input) => {
      const delegateTapLeaf = delegatedScript.delegate();
      const tx = new Transaction({
        version: 3,
      });
      tx.addInput({
        txid: input.txid,
        index: input.vout,
        witnessUtxo: {
          amount: BigInt(input.value),
          script: delegatedScript.pkScript,
        },
        sighashType: SigHash.ALL_ANYONECANPAY,
        tapLeafScript: [delegateTapLeaf],
      });
      tx.addOutput({
        script: OutScript.encode(
          Address(NETWORK).decode(operatorInfo.forfeitAddress)!,
        ),
        amount: BigInt(input.value) + wallet.dustAmount,
      });
      tx.addOutput(P2A);
      return identity.sign(tx);
    }),
).then((signedTxs) =>
  signedTxs.map((signedTx) => base64.encode(signedTx.toPSBT())),
);

/** 8. Submit delegation request */
await delegate.delegate(signedIntent, forfeitTxs);

console.log(
  `Delegated exit:`,
  Transaction.fromPSBT(base64.decode(signedIntent.proof)),
);

/** 9. Graceful shutdown */
console.log("Disposing contract manager...");
contractManager.dispose();

console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
