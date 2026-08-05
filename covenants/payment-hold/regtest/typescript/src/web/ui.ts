/** Small DOM helpers shared by both views — no framework, no magic. */

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
}

export function el(
    tag: string,
    attrs: Record<string, string> = {},
    ...children: (Node | string)[]
): HTMLElement {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
}

export function fmtSats(v: bigint | number): string {
    return `${Number(v).toLocaleString("en-US")} sats`;
}

export function shorten(s: string, head = 12, tail = 6): string {
    return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

const STATE_CLASS: Record<string, string> = {
    unfunded: "badge gray",
    authorized: "badge blue",
    captured: "badge green",
    voided: "badge orange",
    reclaimed: "badge orange",
    "spent-unknown": "badge gray",
};

export function stateBadge(state: string): HTMLElement {
    return el("span", { class: STATE_CLASS[state] ?? "badge gray" }, state);
}

export function copyButton(text: () => string, label = "copy"): HTMLElement {
    const btn = el("button", { class: "ghost" }, label);
    btn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(text());
        btn.textContent = "copied!";
        setTimeout(() => (btn.textContent = label), 1200);
    });
    return btn;
}

export function makeLogger(pane: HTMLElement): (msg: string) => void {
    return (msg) => {
        const line = el(
            "div",
            { class: "logline" },
            `${new Date().toLocaleTimeString()}  ${msg}`,
        );
        pane.prepend(line);
        while (pane.childElementCount > 200) pane.lastElementChild?.remove();
    };
}

/** Persist/load a list of base64url-encoded hold terms. */
export function holdStore(key: string): {
    all(): string[];
    add(encoded: string): void;
    clear(): void;
} {
    return {
        all: () => JSON.parse(localStorage.getItem(key) ?? "[]"),
        add: (encoded) => {
            const cur: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");
            if (!cur.includes(encoded)) {
                cur.push(encoded);
                localStorage.setItem(key, JSON.stringify(cur));
            }
        },
        clear: () => localStorage.removeItem(key),
    };
}

/** Load or create a persisted 32-byte private key (hex) for this role. */
export function loadOrCreateKeyHex(storageKey: string): string {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hexKey = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(storageKey, hexKey);
    return hexKey;
}
