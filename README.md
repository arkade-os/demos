# Arkade SDK Demos

A collection of tiny, self-contained example apps for the [Arkade
TypeScript SDK](https://github.com/arkade-os/ts-sdk) (`@arkade-os/sdk`).
Each demo is a single annotated `index.ts` that does one thing and logs
the result — copy any of them as a starting point.

## Run a demo

Every demo lives at `<category>/<demo>/<network>/typescript/`. Pick one,
then:

```bash
cd identity/mnemonic/testnet/typescript
pnpm install
pnpm dev
```

Requirements: **Node 22+** (runs `.ts` directly) and **pnpm**. Most
demos have both `mainnet/` and `testnet/` variants — start with
`testnet`.

## What's inside

| Category        | Shows how to…                                                              |
| --------------- | -------------------------------------------------------------------------- |
| `address`       | decode and inspect an Arkade address                                       |
| `identity`      | build a signing identity from a mnemonic, seed, hex key, npub/nsec, descriptor |
| `wallet`        | create a wallet and read address, balance, outputs; consolidate; recover   |
| `scripts`       | construct VTXO scripts: default, boarding, delegated, escrow, multisig, timelock, vhtlc |
| `indexer`       | query the indexer for outputs, virtual txs, vtxo chains, asset details     |
| `asset-manager` | issue, burn, notify, and inspect Arkade Assets *(testnet only)*            |
| `boltz-swap`    | swap between Lightning and Arkade via [Boltz](https://boltz.exchange)       |
| `old/`          | legacy lower-level demos (TS + some Rust/Go), kept for reference           |

## Learn more

- Docs: https://docs.arkadeos.com
- SDK: https://github.com/arkade-os/ts-sdk
