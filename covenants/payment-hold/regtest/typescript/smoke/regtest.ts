/**
 * Regtest helpers for the smoke test (node-only). Assumes the arkade regtest
 * stack is running locally:
 *   arkd + indexer  http://localhost:7070
 *   emulator        http://localhost:7073
 *   esplora         http://localhost:3000
 *
 * Faucet and mining shell out to the stack's containers; override with the
 * FAUCET_CMD / MINE_CMD env vars if your setup differs. `{addr}`, `{amount}`
 * and `{n}` are substituted.
 */
import { execSync } from "node:child_process";
import { hex } from "@scure/base";
import type { RestIndexerProvider, VirtualCoin } from "@arkade-os/sdk";
import { providerUrls } from "../src/lib/client.ts";

const FAUCET_CMD =
    process.env.FAUCET_CMD ??
    "docker exec -t arkd ark send --to {addr} --amount {amount} --password secret";

export function faucetOffchain(address: string, amount: number): void {
    const cmd = FAUCET_CMD.replaceAll("{addr}", address).replaceAll("{amount}", String(amount));
    execSync(cmd, { stdio: "pipe" });
}

/**
 * Advance the regtest chain by `n` blocks. Runs MINE_CMD when provided;
 * otherwise prints instructions and waits for the height to move (some stacks
 * automine, some need a manual nudge).
 */
export async function mineBlocks(n: number, timeoutMs = 120_000): Promise<void> {
    const start = await tipHeight();
    const target = start + n;
    const mineCmd = process.env.MINE_CMD;
    if (mineCmd) {
        execSync(mineCmd.replaceAll("{n}", String(n)), { stdio: "pipe" });
    } else {
        console.log(
            `    → need ${n} block(s): run \`node regtest/regtest.mjs mine ${n}\` in your ` +
                `arkade-regtest checkout (or set MINE_CMD) — waiting for height ${target}…`,
        );
    }
    await waitForHeight(target, timeoutMs);
}

export async function tipHeight(): Promise<number> {
    const res = await fetch(`${providerUrls().esplora}/api/blocks/tip/height`);
    if (!res.ok) throw new Error(`esplora: ${res.status}`);
    return Number(await res.text());
}

export async function waitForHeight(target: number, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if ((await tipHeight()) >= target) return;
        await sleep(1_000);
    }
    throw new Error(`timed out waiting for chain height ${target}`);
}

export async function waitForVtxo(
    indexer: RestIndexerProvider,
    pkScript: Uint8Array,
    opts: { spent?: boolean; timeoutMs?: number } = {},
): Promise<VirtualCoin> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const script = hex.encode(pkScript);
    while (Date.now() < deadline) {
        const { vtxos } = await indexer.getVtxos({ scripts: [script] });
        const hit = vtxos.find((v) => (opts.spent ? v.isSpent : !v.isSpent));
        if (hit) return hit;
        await sleep(1_000);
    }
    throw new Error(`timed out waiting for ${opts.spent ? "spent" : "unspent"} vtxo`);
}

export async function waitFor<T>(
    fn: () => Promise<T | undefined | null | false>,
    what: string,
    timeoutMs = 30_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const v = await fn();
        if (v) return v;
        await sleep(1_000);
    }
    throw new Error(`timed out waiting for ${what}`);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Verify the stack is reachable; exit with setup hints when it is not. */
export async function preflight(): Promise<void> {
    const urls = providerUrls();
    const checks: Array<[string, string]> = [
        ["arkd", `${urls.arkd}/v1/info`],
        ["emulator", `${urls.emulator}/v1/info`],
        ["esplora", `${urls.esplora}/api/blocks/tip/height`],
    ];
    const failures: string[] = [];
    for (const [name, url] of checks) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
            if (!res.ok) failures.push(`${name} (${url}) → HTTP ${res.status}`);
        } catch {
            failures.push(`${name} (${url}) → unreachable`);
        }
    }
    if (failures.length > 0) {
        console.error("regtest stack not reachable:\n  " + failures.join("\n  "));
        console.error(
            "\nStart the arkade regtest stack first (ts-sdk repo: `./scripts/regtest.sh ts-sdk up`," +
                "\nor your arkade-regtest checkout), then re-run `pnpm smoke`." +
                "\nOverride endpoints with ARKD_URL / EMULATOR_URL / ESPLORA_URL.",
        );
        process.exit(1);
    }
}
