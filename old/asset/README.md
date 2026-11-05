## Arkade Asset Demos

Demonstrates:

1. creating a wallet
2. fetching asset balances
3. retrieving metadata and parsing asset values
4. burning assets
5. issuing control assets
6. issuing a child asset with a control asset
7. reissuing the same child asset using the control asset
8. sending both bitcoin + multiple assets in the same transaction

To get started, go to https://arkade.money > Settings > Backup, take the `nsec...` key, decode it on https://www.nostrly.com/nip-19-entity-decoder, and add it as the top-level `PRIVATE_KEY` in all three files.

### TypeScript
`pnpm install && pnpm dev`

### Golang
`gofmt -w main.go && go run .`

### Rust
`cargo run`