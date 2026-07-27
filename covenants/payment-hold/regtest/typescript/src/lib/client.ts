/**
 * Connection helpers, environment-aware:
 * - in the browser, all traffic goes through the Vite dev proxy (`/arkd`,
 *   `/emulator`, `/esplora`) so no CORS setup is needed on the regtest stack;
 * - in node (smoke test), providers hit localhost directly, overridable via
 *   ARKD_URL / EMULATOR_URL / ESPLORA_URL.
 */
import {
    arkade,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
    type Identity,
} from "@arkade-os/sdk";

const inBrowser = typeof window !== "undefined";

export interface ProviderUrls {
    arkd: string;
    emulator: string;
    esplora: string;
}

export function providerUrls(): ProviderUrls {
    if (inBrowser) {
        const base = window.location.origin;
        return { arkd: `${base}/arkd`, emulator: `${base}/emulator`, esplora: `${base}/esplora` };
    }
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
        ?.env;
    return {
        arkd: env?.ARKD_URL ?? "http://localhost:7070",
        emulator: env?.EMULATOR_URL ?? "http://localhost:7073",
        esplora: env?.ESPLORA_URL ?? "http://localhost:3000",
    };
}

export function indexerProvider(): RestIndexerProvider {
    return new RestIndexerProvider(providerUrls().arkd);
}

/** A connected Arkade client for contract derivation and covenant spends. */
export async function connectArkade(identity?: Identity): Promise<arkade.Arkade> {
    const urls = providerUrls();
    return arkade.Arkade.connect({
        arkade: new RestArkProvider(urls.arkd),
        emulator: new RestEmulatorProvider(urls.emulator),
        indexer: new RestIndexerProvider(urls.arkd),
        identity,
        network: networks.regtest,
    });
}

/**
 * A payment wallet for one demo role (merchant or customer). In-memory
 * repositories: the demo re-syncs from the indexer on load, so nothing needs
 * to survive a reload except the identity key (persisted by the caller).
 */
export async function createRoleWallet(identity: Identity): Promise<Wallet> {
    const urls = providerUrls();
    return Wallet.create({
        identity,
        arkServerUrl: urls.arkd,
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });
}

export function identityFromHex(privHex: string): SingleKey {
    return SingleKey.fromHex(privHex);
}

export function newIdentity(): SingleKey {
    return SingleKey.fromRandomBytes();
}

/** Current chain tip height via esplora. */
export async function chainTipHeight(): Promise<number> {
    const res = await fetch(`${providerUrls().esplora}/api/blocks/tip/height`);
    if (!res.ok) throw new Error(`esplora tip height failed: ${res.status}`);
    return Number(await res.text());
}
