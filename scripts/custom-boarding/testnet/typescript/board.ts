import {
  type ContractHandler,
  contractHandlers,
  CSVMultisigTapscript,
  ESPLORA_URL,
  EsploraProvider,
  type ExtendedCoin,
  hasBoardingTxExpired,
  MnemonicIdentity,
  MultisigTapscript,
  networks,
  Ramps,
  type RelativeTimelock,
  RestArkProvider,
  VtxoScript,
  Wallet,
} from "@arkade-os/sdk";
import {
  type SQLExecutor,
  SQLiteContractRepository,
  SQLiteWalletRepository,
} from "@arkade-os/sdk/repositories/sqlite";
import { hex } from "@scure/base";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const BACKUP_SEED_PHRASE =
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong" as const;
const OPERATOR_URL = "https://mutinynet.arkade.sh" as const;
const EXPLORER_URL = "https://explorer.mutinynet.arkade.sh" as const;

/** 1. Initialize SQLite database */
const initDB = (dbPath: string) => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  const sqlExecutor = {
    run: async (sql, params) => {
      db.prepare(sql).run(...((params ?? []) as SQLInputValue[]));
    },
    get: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...((params ?? []) as SQLInputValue[])) as
        | T
        | undefined,
    all: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...((params ?? []) as SQLInputValue[])) as T[],
  } as const satisfies SQLExecutor;
  const closeDB = () => db.close();
  return { sqlExecutor, closeDB };
};
const { sqlExecutor, closeDB } = initDB("wallet.sqlite");

/** 2. Create user and backup identities */
const userIdentity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
  isMainnet: false,
});
const backupIdentity = MnemonicIdentity.fromMnemonic(BACKUP_SEED_PHRASE, {
  isMainnet: false,
});

/** 3. Extract user and backup x-only public keys */
const userPubkey = await userIdentity.xOnlyPublicKey();
const backupPubkey = await backupIdentity.xOnlyPublicKey();

/** 4. Connect to operator */
const operator = new RestArkProvider(OPERATOR_URL);
const operatorInfo = await operator.getInfo();

/** 5. Extract operator x-only public key */
const operatorPubkey = hex.decode(operatorInfo.signerPubkey).slice(1);

/** 6. Extract operator boarding exit timelock, and double it for recovery */
const exitTimelock = {
  value: BigInt(operatorInfo.boardingExitDelay),
  type: "seconds",
} as const satisfies RelativeTimelock;
const recoveryTimelock = {
  value: exitTimelock.value * 2n,
  type: "seconds",
} as const satisfies RelativeTimelock;

/** 7. Construct custom boarding tapscript (same as index.ts) */
const collaborativeScript = MultisigTapscript.encode({
  pubkeys: [userPubkey, operatorPubkey],
}).script;

const customBoardingTapscript = new VtxoScript([
  // user + operator (boarding spends this path)
  collaborativeScript,
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
const boardingAddress = customBoardingTapscript.onchainAddress(
  networks.mutinynet,
);

/**
 * 8. Fetch onchain outputs at the custom boarding address
 *
 * Wallet.getBoardingUtxos() only checks DefaultVtxo boarding addresses,
 * so ask the onchain provider directly.
 */
const onchain = new EsploraProvider(ESPLORA_URL.mutinynet);
const coins = await onchain.getCoins(boardingAddress);

/**
 * 9. Attach the custom boarding tapscript to each output
 *
 * The wallet signs both the batch registration request and the commitment
 * transaction through the user + operator path. The SDK's helper for this,
 * extendCoinWithTapscript, is internal and only accepts DefaultVtxo.Script,
 * so build the inputs here.
 */
const collaborativeLeaf = customBoardingTapscript.findLeaf(
  hex.encode(collaborativeScript),
);
const extendedCoins = coins.map((coin) => ({
  ...coin,
  forfeitTapLeafScript: collaborativeLeaf,
  intentTapLeafScript: collaborativeLeaf,
  tapTree: customBoardingTapscript.encode(),
})) satisfies ExtendedCoin[];

/**
 * 10. Keep the outputs the operator accepts
 *
 * The operator only accepts confirmed outputs whose shortest exit delay
 * (exitTimelock) hasn't passed yet. One rejected input fails the whole
 * boarding, so skip expired outputs: only an exit path can spend them.
 */
const confirmedCoins = extendedCoins.filter((coin) => coin.status.confirmed);
const boardingInputs = confirmedCoins.filter(
  (coin) => !hasBoardingTxExpired(coin, exitTimelock),
);

const expiredCount = confirmedCoins.length - boardingInputs.length;
if (expiredCount) {
  console.warn(
    `Skipping ${expiredCount} expired output(s), spend them through an exit path`,
  );
}

if (!boardingInputs.length) {
  throw new Error(
    coins.length > confirmedCoins.length
      ? `Found ${coins.length - confirmedCoins.length} unconfirmed output(s), wait for confirmation:`
      : "No outputs to board, fund this address:",
    { cause: boardingAddress },
  );
}

/**
 * 11. Register a contract handler for raw tapscripts
 *
 * The wallet needs a contract for this script (step 13), and every contract
 * type needs a handler that rebuilds the script from the contract's params.
 * No built-in handler builds this script, so register one that stores the
 * whole tap tree. It returns no spending paths, because the wallet spends
 * these outputs only by boarding them, with the inputs from step 10.
 */
const RAW_TAPSCRIPT_HANDLER = {
  type: "raw-tapscript",
  createScript: (params) => VtxoScript.decode(hex.decode(params.tapTree)),
  serializeParams: (params) => params,
  deserializeParams: (params) => params,
  selectPath: () => null,
  getAllSpendingPaths: () => [],
  getSpendablePaths: () => [],
} satisfies ContractHandler<Record<string, string>>;

contractHandlers.register(RAW_TAPSCRIPT_HANDLER);

/** 12. Create wallet */
const wallet = await Wallet.create({
  identity: userIdentity,
  arkProvider: operator,
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

/**
 * 13. Register the custom boarding tapscript as a contract
 *
 * The wallet signs an input only if its script matches one of the wallet's
 * contracts, or the wallet's own DefaultVtxo boarding script. It skips any
 * other input without an error, and that input reaches the operator unsigned.
 *
 * Watch 'retained': this script only holds onchain outputs, so the indexer
 * has nothing to watch. Registering the same script and type again does
 * nothing, so reruns are safe.
 */
const contractManager = await wallet.getContractManager();
await contractManager.createContract({
  label: "Custom boarding",
  type: RAW_TAPSCRIPT_HANDLER.type,
  params: { tapTree: hex.encode(customBoardingTapscript.encode()) },
  script: hex.encode(customBoardingTapscript.pkScript),
  address: boardingAddress,
  watch: "retained",
});

/** 14. Board the outputs into a virtual output at the wallet's Arkade address */
console.log(
  `Boarding ${boardingInputs.length} output(s) to ${await wallet.getAddress()}, waiting for next batch...`,
);
const commitmentTxid = await new Ramps(wallet).onboard(
  operatorInfo.fees,
  boardingInputs,
  undefined,
  (event) => console.log(`  ${event.type}`),
);
console.log(`Boarded: ${EXPLORER_URL}/tx/${commitmentTxid}`);

/** 15. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
