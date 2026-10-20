<!-- applications -->

- [-] covered call option: oracle-settled RFQ flow (`OP_CHECKSIGFROMSTACK` 3-of-5 median, `OP_INSPECTOUTPUTVALUE`, `OP_INSPECTOUTPUTSCRIPTPUBKEY`, `OP_INSPECTNUMINPUTS`)
  - [ ] mainnet
    - [ ] typescript
    - [ ] go
    - [ ] rust
    - [ ] .net
  - [-] testnet
    - [x] typescript
    - [ ] go
    - [ ] rust
    - [ ] .net

<!-- output introspection -->

- [-] pay to exact amount `OP_INSPECTOUTPUTVALUE`
  - [ ] mainnet
    - [ ] typescript
  - [x] testnet
    - [x] typescript

<!-- input introspection -->

- [ ] pin input to an outpoint `OP_INSPECTINPUTOUTPOINT`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] require minimum input value `OP_INSPECTINPUTVALUE`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] pin input scriptPubKey `OP_INSPECTINPUTSCRIPTPUBKEY`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] pin input sequence `OP_INSPECTINPUTSEQUENCE`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] recursive covenant: pin input's arkade script `OP_INSPECTINPUTARKADESCRIPTHASH`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] recursive covenant: pin input's arkade witness `OP_INSPECTINPUTARKADEWITNESSHASH`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] self-referencing input index `OP_PUSHCURRENTINPUTINDEX`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

<!-- output introspection -->

- [ ] pin output scriptPubKey `OP_INSPECTOUTPUTSCRIPTPUBKEY`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

<!-- transaction introspection -->

- [ ] pin transaction version `OP_INSPECTVERSION`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] pin transaction locktime `OP_INSPECTLOCKTIME`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] restrict input count `OP_INSPECTNUMINPUTS`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] restrict output count `OP_INSPECTNUMOUTPUTS`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] cap transaction weight `OP_TXWEIGHT`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] pin transaction id `OP_TXID`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

<!-- signatures & hashing -->

- [ ] signature over arbitrary data (oracle/DLC) `OP_CHECKSIGFROMSTACK`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] alternate-key signature check `OP_SIGHASH`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

<!-- extension packet introspection -->

- [ ] require an emulator packet `OP_INSPECTPACKET`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

- [ ] require an input's source-tx packet `OP_INSPECTINPUTPACKET`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

<!-- asset-group introspection -->

- [ ] pay exact asset amount `OP_INSPECTNUMASSETGROUPS` + `OP_INSPECTASSETGROUPSUM`
  - [ ] mainnet
    - [ ] typescript
  - [ ] testnet
    - [ ] typescript

more here: https://github.com/arkade-os/emulator