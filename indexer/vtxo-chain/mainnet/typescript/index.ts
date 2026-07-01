import { ChainTxType, RestIndexerProvider } from "@arkade-os/sdk";
import { base64urlnopad, utf8 } from "@scure/base";
import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const OUTPOINT = {
  txid: "70571e9542ce81c1e23ab6eb3dfb7dafb050171ae1d632e75a093cf445b8d786",
  vout: 0,
} as const;

const MERMAID_URL = "https://mermaid.live" as const;

/** 1. Connect to indexer */
const indexer = new RestIndexerProvider();

/** 2. Fetch virtual output transaction chain */
const { chain: chainTxs } = await indexer.getVtxoChain(OUTPOINT);

/** 3. Format as Mermaid diagram */
const TYPE = {
  INDEXER_CHAINED_TX_TYPE_UNSPECIFIED: "unknown",
  INDEXER_CHAINED_TX_TYPE_TREE: "batch-tree-tx",
  INDEXER_CHAINED_TX_TYPE_COMMITMENT: "commitment-tx",
  INDEXER_CHAINED_TX_TYPE_CHECKPOINT: "checkpoint-tx",
  INDEXER_CHAINED_TX_TYPE_ARK: "arkade-tx",
} as const satisfies Record<ChainTxType, string>;

const truncateTxid = (s: string) => s.slice(0, 8);
const nodeId = (txid: string) => `n_${txid.slice(0, 12)}`;

const lines = ["graph LR"];
const seenConnections = new Set<string>();

for (const tx of chainTxs) {
  lines.push(
    `${nodeId(tx.txid)}["${truncateTxid(tx.txid)}<br/>${TYPE[tx.type]}"]`,
  );

  for (const spend of tx.spends) {
    const parentTxid = spend.split(":")[0];
    const connection = `${parentTxid}->${tx.txid}`;
    if (seenConnections.has(connection)) continue;
    seenConnections.add(connection);
    lines.push(`${nodeId(parentTxid)} --> ${nodeId(tx.txid)}`);
  }
}

await writeFile("dag.mmd", lines.join("\n"), "utf8");
console.log("Wrote dag.mmd");
console.log("Run 'pnpm render' to generate SVG");

console.log("\nOpen in browser:");
console.log(
  `${MERMAID_URL}/view#pako:${base64urlnopad.encode(
    deflateSync(
      utf8.decode(
        JSON.stringify({
          code: lines.join("\n"),
          mermaid: { theme: "default" },
          autoSync: true,
          updateDiagram: true,
          editorMode: "preview",
        }),
      ),
    ),
  )}`,
);
