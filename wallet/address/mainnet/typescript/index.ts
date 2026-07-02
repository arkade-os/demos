import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MnemonicIdentity,
  RestArkProvider,
  RestDelegateProvider,
  Wallet,
} from "@arkade-os/sdk";

const SEED_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const DELEGATE_URL = "https://delegate.arkade.money" as const;

/** 1. Create identity */
const identity = MnemonicIdentity.fromMnemonic(SEED_PHRASE);

/** 2. Create wallet */
const wallet = await Wallet.create({
  identity,
  arkProvider: new RestArkProvider(),
  delegateProvider: new RestDelegateProvider(DELEGATE_URL),
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
   * Explicitly use in-memory storage
   * Defaults to IndexedDB if undefined
   */
  storage: {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  },
});

/** 3. Log wallet addresses (standard + boarding) */
console.log({
  arkadeAddress: await wallet.getAddress(),
  boardingAddress: await wallet.getBoardingAddress(),
});
