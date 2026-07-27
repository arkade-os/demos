# ⛽ Payment Hold — authorize & capture on Arkade

A serverless "authorize and capture" payment demo, gas-pump style: the customer
taps to lock a **hold**, the merchant later **captures** the metered amount
(the remainder returns to the customer automatically), can **void** the
authorization, and the customer can unilaterally **reclaim** after a timelock.

No payment processor, no merchant backend, no webhooks: a per-payment covenant
VTXO is the escrow, and an indexer SSE subscription is the notification
channel. Merchant and customer each run a static web page and a wallet key.

## The Coinbase Commerce comparison

Coinbase/Shopify's [Commerce Payments Protocol](https://github.com/base/commerce-payments)
(`AuthCaptureEscrow` on Base) proved card-style authorize/capture works
on-chain — but an *operator* drives every state transition, and charge
creation, webhooks, and dashboards stay on Coinbase servers. This demo is the
permissionless version of the same semantics:

| Commerce Payments (`AuthCaptureEscrow`)          | This demo                                              |
| ------------------------------------------------ | ------------------------------------------------------ |
| `authorize()` — pull funds into a shared escrow contract | customer funds the covenant address (the VTXO **is** the hold) |
| `capture(amount)` — operator-only, partial       | `capture` path — merchant-signed, amount is a witness value, change auto-returns |
| capture of the full/remaining escrow             | `captureAll` path (also absorbs sub-dust change)       |
| `void()` — operator-only                         | `void` path — merchant-signed full release             |
| `reclaim()` — payer-only, after `authorizationExpiry` | `reclaim` path — customer-signed CLTV at `releaseHeight` |
| payment ID = struct hash in contract storage     | payment ID = the outpoint (one covenant address per hold, via `orderSalt`) |
| webhooks + dashboard for state                   | indexer SSE subscription + tapleaf classification      |
| operator service submits and pays gas            | any static page submits; the Arkade co-signer enforces the covenant |

## What's in here

| Piece                                | Path                                    |
| ------------------------------------ | --------------------------------------- |
| **JSON artifact** (SDK program)      | `contract/payment-hold.program.json`    |
| Typed program + JS lib               | `src/lib/` (`program`, `terms`, `hold`, `watch`, `client`) |
| **Merchant terminal** (web)          | `merchant.html` + `src/web/merchant.ts` |
| **Customer wallet** (web)            | `customer.html` + `src/web/customer.ts` |
| Contract playground (WASM compiler)  | `playground/`                           |
| Smoke test (regtest, e2e)            | `smoke/smoke.ts`                        |
| Offline unit tests                   | `test/`                                 |
| Reference `.ark` contracts + compiler artifact | `contract/reference/`         |

## The covenant

Five spending paths (see `src/lib/program.ts` for the annotated source):

- **capture(captureAmount)** — merchant + server sign; the arkade script pins
  `out0 = merchant payout = captureAmount`, `out1 = customer payout`, and
  `out0 + out1 == input value`. Because arkd enforces transaction value
  conservation, that arithmetic makes any third value-bearing output
  impossible — no output-count check needed.
- **captureAll()** — full hold to the merchant. The lib routes captures whose
  change would be ≤ 330 sats here (sub-dust change rides to the merchant).
- **void()** — full hold back to the customer, merchant-signed.
- **reclaim()** — full hold back to the customer, customer-signed, valid only
  after `releaseHeight` (CLTV). This is the anti-hostage path: an unresponsive
  merchant can delay settlement, never confiscate.
- **exit** — merchant CSV leaf for L1 unilateral exit (not exercised by the UI).

`$orderSalt DROP` in the capture path is semantically inert but makes the
covenant bytes — and therefore the derived address — unique per hold.

The covenant runs on the Arkade co-signer (emulator): its key, tweaked by the
arkade-script hash, joins each leaf's signer set, so a spend that violates the
covenant simply never gets co-signed.

## Run it

Prerequisites: node ≥ 22.12, pnpm, and a local arkade regtest stack
(arkd + indexer on `:7070`, emulator on `:7073`, esplora on `:3000` — e.g.
`./scripts/regtest.sh ts-sdk up` in a [ts-sdk](https://github.com/arkade-os/ts-sdk)
checkout).

```bash
pnpm install
pnpm test        # offline unit tests (no stack needed)
pnpm smoke       # end-to-end against the regtest stack
pnpm dev         # web app on http://localhost:5173
```

Walkthrough:

1. Open [merchant](http://localhost:5173/merchant.html) and
   [customer](http://localhost:5173/customer.html) in two tabs.
2. Fund the customer wallet: copy the `pnpm faucet tark1… 200000` command from
   its header and run it.
3. Merchant: set amount/label, **Announce**. The request reaches the customer
   tab via BroadcastChannel (same machine) or the copyable customer link
   (cross-device).
4. Customer: **⛽ Tap to authorize** — the wallet derives the covenant address,
   funds it (terms travel as a TLV extension packet on the funding tx), and
   hands the completed terms back to the merchant tab (or via the copyable
   receipt).
5. Merchant: watch the hold turn `authorized`, pick an amount on the slider,
   **Capture** — the customer sees the change return instantly. Or **Void** to
   release everything.
6. Customer: on a hold the merchant never settles, wait for `releaseHeight`
   (mine a few blocks on regtest) and **Reclaim**.

Both pages persist their key and holds in `localStorage` — "reset demo state"
clears them (do this after a regtest reset: the server keys change, so old
addresses are void).

The smoke test drives the same lifecycle headlessly and additionally
**tamper-tests the covenant**: a capture paying the merchant one sat more than
the witnessed amount, and one routing the change back to the merchant, must
both be rejected by the co-signer.

## Serverless discovery, restore, and limits

- Hold handoff: BroadcastChannel → payment link / pasted receipt → the
  on-chain TLV terms packet (type `0x50`) for restore and audit. The packet
  contains everything needed to re-derive the address and classify the
  lifecycle from public chain data — `restoreTermsFromTx` in `src/lib/hold.ts`.
- Spend classification matches the revealed tapleaf against the compiled
  program (`classifySpend` in `src/lib/watch.ts`), with a payout-pattern
  heuristic as fallback — the webhook, replaced by the chain itself.
- Simplifications vs the reference contract: no processor-fee routing (see
  `contract/reference/payment_hold.ark` for the bps version), single capture
  per hold (no partial-capture-with-recursion), and the demo trusts the
  regtest esplora for chain height.

## Playground

`playground/` compiles the reference `.ark` contracts to their compiler
artifact in-browser via the compiler's WASM build. It loads a locally built
package (`./playground/build.sh /path/to/arkade-os/compiler`) or falls back to
the hosted compiler playground. Note the compiler artifact is **reference
only** today — the demo executes the hand-authored SDK program; see
`contract/reference/README.md` and arkade-os/compiler#64.

## Troubleshooting

- **"cannot reach the regtest stack"** — start the stack; the web app proxies
  `/arkd`, `/emulator`, `/esplora` through Vite, so no CORS setup is needed.
- **Everything broke after a regtest reset** — hit "reset demo state" on both
  pages (stored keys/holds reference the old chain and server keys).
- **`pnpm smoke` hangs waiting for height** — your stack doesn't automine;
  run the mine command it prints, or set `MINE_CMD`.
- **Terms packet warnings** — `wallet.send` extensions are a young SDK
  surface; the demo automatically falls back to a plain send (the hold still
  works, it just isn't restorable from chain data alone).
