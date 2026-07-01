import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  ReadonlyWallet,
  RestArkProvider,
  SingleKey,
} from "@arkade-os/sdk";
import { hex, utf8 } from "@scure/base";

const ASSET_ID =
  "3e52f07e65e9f7eb7366b5f030120cbaa4f5f6961219f1aabe2c775c4ffb0c810000" as const;

/** 1. Create read-only wallet with dummy identity */
const wallet = await ReadonlyWallet.create({
  identity: await SingleKey.fromRandomBytes().toReadonly(),
  arkProvider: new RestArkProvider(),
  /**
   * Explicitly use in-memory storage
   * Defaults to IndexedDB if undefined
   */
  storage: {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
  },
});

/** 2. Fetch asset details */
const assetDetails = await wallet.assetManager.getAssetDetails(ASSET_ID);

if (!assetDetails.controlAssetId) {
  throw new Error("Expected control asset in assetDetails", {
    cause: assetDetails,
  });
}

if (!(assetDetails.metadata && "customField" in assetDetails.metadata)) {
  throw new Error("Expected field 'customField' in assetDetails.metadata", {
    cause: assetDetails.metadata,
  });
}

/** 3. Fetch control asset details */
const controlAssetDetails = await wallet.assetManager.getAssetDetails(
  assetDetails.controlAssetId,
);

if (
  !(
    controlAssetDetails.metadata &&
    "customField" in controlAssetDetails.metadata
  )
) {
  throw new Error(
    "Expected field 'customField' in controlAssetDetails.metadata",
    {
      cause: controlAssetDetails.metadata,
    },
  );
}

/** 4. Summarize asset details */
console.log({
  assetId: assetDetails.assetId,
  supply: assetDetails.supply,
  metadata: {
    ...assetDetails.metadata,
    customField: utf8.encode(
      hex.decode(assetDetails.metadata.customField as string),
    ),
  },
  controlAsset: {
    assetId: controlAssetDetails.assetId,
    supply: controlAssetDetails.supply,
    metadata: {
      ...controlAssetDetails.metadata,
      customField: utf8.encode(
        hex.decode(controlAssetDetails.metadata.customField as string),
      ),
    },
  },
});
