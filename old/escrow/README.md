## Escrow Demo

Demonstrates:

1. connecting to operator and extracting its public key
2. setting up multiple mnenomic identities (arbiter + two players)
3. generating an escrow address with five paths:
    - player A payout (operator, arbiter, player A)
    - player B payout (operator, arbiter, player B)
    - arbiter sweep after timeout (operator, arbiter)
    - players A+B collaboratively exit (operator, player A, player B)
    - players A+B unilaterally exit* (player A, player B)
4. checking balance for the escrow address
5. constructing a transaction spending from one of the paths, depending on the balance (e.g. 330 = path 0, 332 = path 2)
6. submitting the transaction
7. finalizing the checkpoint transactions
8. broadcasting the transaction

> *Unilateral exit logic is not implemented in this example yet, see https://arkade-os.github.io/ts-sdk/#unilateral-exit for more.

### TypeScript
`pnpm install && pnpm dev`

### Rust
`cargo run`
