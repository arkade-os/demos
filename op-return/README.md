## OP_RETURN Demo

Demonstrates:

1. connecting to operator and extracting its public key
2. setting up a mnemonic identity
3. generating a simple address with collaborative spend path
4. checking balance for the address
5. constructing a transaction with three outputs:
    - subdust output (<330 sats)
    - OP_RETURN with a utf-8 encoded message
    - change output sweeping remaining balance
6. submitting the transaction
7. finalizing the checkpoint transactions
8. fetching the transaction from the indexer
9. parsing the outputs, including:
    - standard payments
    - subdust payments
    - utf-8 encoded OP_RETURNs
    - anchor outputs (automatically added by protocol)

### TypeScript
`pnpm install && pnpm dev`

### Rust
`cargo run`
