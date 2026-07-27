/**
 * Contract playground: compile the payment-hold `.ark` sources to their JSON
 * artifact in the browser, via the Arkade compiler's WASM build.
 *
 * The WASM package is looked up in order:
 *   1. `./pkg/arkade_compiler.js` — local build (see ./build.sh)
 *   2. the hosted compiler playground on GitHub Pages
 */
import { contracts } from "./contracts.ts";

const HOSTED_PKG = "https://arkade-os.github.io/compiler/pkg/arkade_compiler.js";

interface CompilerModule {
    default: (input?: unknown) => Promise<unknown>;
    compile: (source: string) => string;
    version: () => string;
}

function $<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

async function loadCompiler(): Promise<CompilerModule> {
    const candidates = [new URL("./pkg/arkade_compiler.js", import.meta.url).href, HOSTED_PKG];
    const failures: string[] = [];
    for (const url of candidates) {
        try {
            const mod = (await import(/* @vite-ignore */ url)) as CompilerModule;
            await mod.default();
            return mod;
        } catch (e) {
            failures.push(`${url}: ${(e as Error).message}`);
        }
    }
    throw new Error(
        `no compiler WASM available.\nBuild it locally with ./playground/build.sh ` +
            `(needs an arkade-os/compiler checkout).\n\n${failures.join("\n")}`,
    );
}

async function main(): Promise<void> {
    const source = $<HTMLTextAreaElement>("source");
    const output = $<HTMLPreElement>("output");
    const status = $("status");
    const picker = $<HTMLSelectElement>("example");
    const compileBtn = $<HTMLButtonElement>("compile");

    for (const name of Object.keys(contracts)) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        picker.appendChild(opt);
    }
    const loadExample = () => {
        source.value = contracts[picker.value];
        output.textContent = "";
    };
    picker.addEventListener("change", loadExample);
    loadExample();

    let compiler: CompilerModule;
    try {
        status.textContent = "loading compiler WASM…";
        compiler = await loadCompiler();
        status.textContent = `arkade-compiler ${compiler.version()} (WASM) ready`;
        compileBtn.disabled = false;
    } catch (e) {
        status.textContent = "compiler unavailable";
        output.textContent = (e as Error).message;
        return;
    }

    const run = () => {
        try {
            const artifact = compiler.compile(source.value);
            output.textContent = JSON.stringify(JSON.parse(artifact), null, 2);
            status.textContent = "compiled ✓ — this is the ContractJson artifact";
        } catch (e) {
            output.textContent = String(e);
            status.textContent = "compile error";
        }
    };
    compileBtn.addEventListener("click", run);
    run();
}

void main();
