# boltz-core

[![CI](https://github.com/BoltzExchange/boltz-core/actions/workflows/CI.yml/badge.svg)](https://github.com/BoltzExchange/boltz-core/actions/workflows/CI.yml)
[![Version](http://img.shields.io/npm/v/boltz-core.svg)](https://www.npmjs.com/package/boltz-core)

Boltz Reference Client & Library in TypeScript, used by e.g. https://github.com/BoltzExchange/boltz-web-app.

The library exposes building blocks for Boltz-style submarine and reverse swaps: swap scripts and Taproot swap trees, claim/refund transaction construction, MuSig2 helpers, preimage/swap detection, and the Solidity `EtherSwap`/`ERC20Swap` ABIs.

## Installation

```bash
npm install boltz-core
```

The package is **ESM only** and requires Node.js `>=20.10`.

### Optional peer dependencies

Liquid support is opt-in. The two peer dependencies are declared as optional, so installing `boltz-core` on its own pulls no Liquid code:

- [`liquidjs-lib`](https://www.npmjs.com/package/liquidjs-lib)
- [`@vulpemventures/secp256k1-zkp`](https://www.npmjs.com/package/@vulpemventures/secp256k1-zkp)

Install them only if you import from `boltz-core/liquid`:

```bash
npm install liquidjs-lib @vulpemventures/secp256k1-zkp
```

The main `boltz-core` entry point never imports either package, so Bitcoin-only consumers will not see them in their bundle or dependency tree.

## Usage

### Bitcoin

```ts
import {
  Networks,
  OutputType,
  constructClaimTransaction,
  swapTree,
} from 'boltz-core';
```

### Liquid

`boltz-core/liquid` requires a one-time `init` call with a loaded `secp256k1-zkp` instance before any swap helpers are used:

```ts
import zkpInit from '@vulpemventures/secp256k1-zkp';
import {
  Networks,
  constructClaimTransaction,
  init,
  reverseSwapTree,
} from 'boltz-core/liquid';

const zkp = await zkpInit();
init(zkp);
```

## Development

```bash
npm install
npm run compile
npm test
```

Integration tests need local Bitcoin and Elements regtest nodes:

```bash
npm run docker:start
npm run test:int
npm run docker:stop
```
