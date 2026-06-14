// SPDX-License-Identifier: MIT

pragma solidity ^0.8.33;

import {EtherSwap} from "./EtherSwap.sol";

// @title Hash timelock contract for Ether using block timestamps for timeouts
contract EtherSwapTimestamp is EtherSwap {
    function currentTime() internal view override returns (uint256) {
        return block.timestamp;
    }
}
