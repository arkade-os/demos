# Reference contracts (not executed by the demo)

- `payment_hold.ark` / `asset_payment_hold.ark` — the full Arkade Script
  contracts this demo implements, from
  [arkade-os/compiler#66](https://github.com/arkade-os/compiler/pull/66). The
  `.ark` version includes processor-fee basis-point routing that the demo
  program omits.
- `payment_hold.artifact.json` — the Arkade compiler's `ContractJson` output
  for `payment_hold.ark`. **Reference only**: this artifact shape is not yet
  consumable by `@arkade-os/sdk` (`OP_`-prefixed tokens, `<name>` placeholders
  including unresolvable `let`-bindings). The executable program the demo runs
  is the hand-authored `../payment-hold.program.json`. Emitting the SDK
  program format from the compiler is tracked in
  [arkade-os/compiler#64](https://github.com/arkade-os/compiler/issues/64).

Compile the `.ark` sources in your browser on the demo's
[contract playground](../../playground/index.html) page.
