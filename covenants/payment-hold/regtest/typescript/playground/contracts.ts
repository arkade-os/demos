/**
 * Example contract sources for the playground, copied verbatim from
 * arkade-os/compiler examples/payment_hold/ (PR #66). Regenerate by re-running
 * the copy when the upstream contracts change.
 */
export const contracts: Record<string, string> = {
    "payment_hold.ark": `// Payment Hold Contract (authorize and capture)
// Gas-pump style card payment over a BTC hold:
//
// 1. Authorize: customer taps and funds this covenant with the hold amount
//    (e.g. 100 000 sats before fueling starts). The funded VTXO value IS the
//    hold; no separate amount parameter is needed.
// 2. Capture: merchant settles the actual amount — chosen at capture time as
//    a witness value, up to the hold — minus the processor fee. The unused
//    remainder returns to the customer as change.
// 3. Void: merchant cancels the authorization and returns the full hold to
//    the customer immediately.
// 4. Refund: after releaseBlockHeight anyone can return the hold to the
//    customer — the automatic release if the merchant never charges.
//
// Unlike payment_auth.ark, the settled amount is not fixed at authorization
// time: capture takes it as a witness, so one covenant covers any final
// charge up to the hold.

contract PaymentHold(
  // Processor fee in basis points of the captured amount
  int feeRateBasisPoints,

  // Output scripts (P2TR scriptPubKeys)
  bytes merchantScript,
  bytes processorScript,
  bytes customerScript,

  // Auto-release timelock (block height)
  int releaseBlockHeight,

  // Capture/void authorization key
  pubkey merchantPubkey,

  // Exit timelock in blocks
  int exit
) {

  // Capture: merchant-authorized settlement of captureAmount <= hold.
  // Sub-dust fee or change is routed into the merchant payout because a
  // sub-330-sat Taproot output is not viable.
  function capture(int captureAmount, signature merchantSig) {
    require(checkSig(merchantSig, merchantPubkey), "invalid merchant signature");

    let held = tx.input.current.value;
    require(captureAmount > 330, "capture below dust");
    require(captureAmount <= held, "capture exceeds hold");
    // 21 000 BTC ceiling keeps captureAmount * feeRateBasisPoints inside i64
    require(captureAmount <= 2100000000000, "capture too large");
    require(feeRateBasisPoints >= 0, "negative fee rate");
    require(feeRateBasisPoints <= 10000, "fee rate > 100%");

    int processorFee = captureAmount * feeRateBasisPoints / 10000;
    int merchantAmount = captureAmount - processorFee;
    require(merchantAmount > 330, "merchant payout below dust");
    int change = held - captureAmount;

    if (processorFee > 330) {
      if (change > 330) {
        // Full split: merchant + processor + customer change
        require(tx.numOutputs == 3, "expected 3 outputs");
        require(tx.outputs[0].value == merchantAmount, "merchant amount incorrect");
        require(tx.outputs[0].scriptPubKey == merchantScript, "merchant script incorrect");
        require(tx.outputs[1].value == processorFee, "processor fee incorrect");
        require(tx.outputs[1].scriptPubKey == processorScript, "processor script incorrect");
        require(tx.outputs[2].value == change, "change amount incorrect");
        require(tx.outputs[2].scriptPubKey == customerScript, "change script incorrect");
      } else {
        // Sub-dust change rounds up into the merchant payout
        require(tx.numOutputs == 2, "expected 2 outputs");
        int merchantWithChange = merchantAmount + change;
        require(tx.outputs[0].value == merchantWithChange, "merchant amount incorrect");
        require(tx.outputs[0].scriptPubKey == merchantScript, "merchant script incorrect");
        require(tx.outputs[1].value == processorFee, "processor fee incorrect");
        require(tx.outputs[1].scriptPubKey == processorScript, "processor script incorrect");
      }
    } else {
      // Sub-dust fee rides with the merchant payout; processor settles out of band
      if (change > 330) {
        require(tx.numOutputs == 2, "expected 2 outputs");
        int merchantWithFee = merchantAmount + processorFee;
        require(tx.outputs[0].value == merchantWithFee, "merchant amount incorrect");
        require(tx.outputs[0].scriptPubKey == merchantScript, "merchant script incorrect");
        require(tx.outputs[1].value == change, "change amount incorrect");
        require(tx.outputs[1].scriptPubKey == customerScript, "change script incorrect");
      } else {
        // Full capture: everything goes to the merchant
        require(tx.numOutputs == 1, "expected 1 output");
        require(tx.outputs[0].value == held, "merchant amount incorrect");
        require(tx.outputs[0].scriptPubKey == merchantScript, "merchant script incorrect");
      }
    }
  }

  // Void: merchant cancels the authorization; the full hold returns to the
  // customer without waiting for the timelock.
  function void(signature merchantSig) {
    require(checkSig(merchantSig, merchantPubkey), "invalid merchant signature");

    let held = tx.input.current.value;
    require(tx.numOutputs == 1, "expected 1 output for void");
    require(tx.outputs[0].value == held, "release amount incorrect");
    require(tx.outputs[0].scriptPubKey == customerScript, "release script incorrect");
  }

  // Refund: timelocked automatic release back to the customer.
  // Becomes valid after releaseBlockHeight — effectively anyone-can-spend
  // into customerScript.
  function refund() {
    require(tx.time >= releaseBlockHeight, "release timelock not reached");

    let held = tx.input.current.value;
    require(tx.numOutputs == 1, "expected 1 output for refund");
    require(tx.outputs[0].value == held, "refund amount incorrect");
    require(tx.outputs[0].scriptPubKey == customerScript, "refund script incorrect");
  }

  // Unilateral exit (CSV): merchant reclaims after the CSV delay.
  // Note: customer's exit is via the refund path above; no single customer
  // pubkey exists.
  function unilateral(signature merchantSig) tapscript {
    require(older(exit));
    require(checkSig(merchantSig, merchantPubkey));
  }
}
`,
    "asset_payment_hold.ark": `// Asset Payment Hold Contract (authorize and capture, asset denominated)
// Same gas-pump flow as payment_hold.ark, but the hold is an Arkade asset
// amount (e.g. 100 units of a USD stable asset) riding on the VTXO:
//
// 1. Authorize: customer funds this covenant with the asset hold.
// 2. Capture: merchant takes the metered asset amount (witness value, up to
//    the hold); the remaining asset units return to the customer.
// 3. Void: merchant returns the full hold to the customer immediately.
// 4. Refund: after releaseBlockHeight anyone can return the hold — the
//    automatic release if the merchant never charges.
//
// Processor fee routing is omitted here to keep the asset mechanics in
// focus; see payment_hold.ark for basis-point fee handling.

contract AssetPaymentHold(
  // Asset ID of the held asset (txid, group index)
  bytes32 assetIdTxid,
  int assetIdGidx,

  // Output scripts (P2TR scriptPubKeys)
  bytes merchantScript,
  bytes customerScript,

  // Auto-release timelock (block height)
  int releaseBlockHeight,

  // Capture/void authorization key
  pubkey merchantPubkey,

  // Exit timelock in blocks
  int exit
) {

  // Capture: merchant takes captureAmount of the held asset; the remainder
  // returns to the customer. Output count is pinned, so the merchant cannot
  // attach own change outputs; relax when merchant-funded fees are needed.
  function capture(int captureAmount, signature merchantSig) {
    require(checkSig(merchantSig, merchantPubkey), "invalid merchant signature");
    require(this.activeInputIndex == 0, "hold must be input 0");

    int heldAssets = tx.inputs[0].assets.lookup(assetIdTxid, assetIdGidx);
    require(captureAmount > 0, "zero capture");
    require(captureAmount <= heldAssets, "capture exceeds hold");

    require(tx.outputs[0].scriptPubKey == merchantScript, "merchant script incorrect");
    require(tx.outputs[0].assets.lookup(assetIdTxid, assetIdGidx) == captureAmount, "merchant asset amount incorrect");
    require(tx.outputs[0].value >= 330, "merchant output below dust");

    int changeAssets = heldAssets - captureAmount;
    if (changeAssets > 0) {
      require(tx.numOutputs == 2, "expected 2 outputs for partial capture");
      require(tx.outputs[1].scriptPubKey == customerScript, "change script incorrect");
      require(tx.outputs[1].assets.lookup(assetIdTxid, assetIdGidx) == changeAssets, "change asset amount incorrect");
      require(tx.outputs[1].value >= 330, "change output below dust");
    } else {
      require(tx.numOutputs == 1, "expected 1 output for full capture");
    }
  }

  // Void: merchant cancels the authorization; the full asset hold and the
  // riding sats return to the customer without waiting for the timelock.
  function void(signature merchantSig) {
    require(checkSig(merchantSig, merchantPubkey), "invalid merchant signature");
    require(this.activeInputIndex == 0, "hold must be input 0");

    int heldAssets = tx.inputs[0].assets.lookup(assetIdTxid, assetIdGidx);
    require(tx.numOutputs == 1, "expected 1 output for void");
    require(tx.outputs[0].scriptPubKey == customerScript, "release script incorrect");
    require(tx.outputs[0].assets.lookup(assetIdTxid, assetIdGidx) == heldAssets, "release asset amount incorrect");
    require(tx.outputs[0].value >= tx.inputs[0].value, "riding sats not returned");
  }

  // Refund: timelocked automatic release back to the customer.
  function refund() {
    require(tx.time >= releaseBlockHeight, "release timelock not reached");
    require(this.activeInputIndex == 0, "hold must be input 0");

    int heldAssets = tx.inputs[0].assets.lookup(assetIdTxid, assetIdGidx);
    require(tx.numOutputs == 1, "expected 1 output for refund");
    require(tx.outputs[0].scriptPubKey == customerScript, "refund script incorrect");
    require(tx.outputs[0].assets.lookup(assetIdTxid, assetIdGidx) == heldAssets, "refund asset amount incorrect");
    require(tx.outputs[0].value >= tx.inputs[0].value, "riding sats not returned");
  }

  // Unilateral exit (CSV): merchant reclaims after the CSV delay.
  // Note: customer's exit is via the refund path above; no single customer
  // pubkey exists.
  function unilateral(signature merchantSig) tapscript {
    require(older(exit));
    require(checkSig(merchantSig, merchantPubkey));
  }
}
`,
};
