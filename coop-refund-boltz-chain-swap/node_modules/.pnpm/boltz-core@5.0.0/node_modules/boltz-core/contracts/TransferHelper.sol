// SPDX-License-Identifier: GPL-3.0-or-later

// Copyright 2020 Uniswap team
// Based on: https://github.com/Uniswap/uniswap-lib/blob/master/contracts/libraries/TransferHelper.sol

pragma solidity ^0.8.33;

library TransferHelper {
    error EtherTransferFailed();
    error TokenTransferFailed();
    error TokenTransferFromFailed();

    /// Transfers Ether to an address
    /// @dev This function reverts if transferring the Ether fails
    /// @dev Please note that ".call" forwards all leftover gas which means that sending Ether to accounts and contract is possible but also that you should specify or sanity check the gas limit
    /// @param to Address to which the Ether should be sent
    /// @param amount Amount of Ether to send in WEI
    function transferEther(address payable to, uint256 amount) internal {
        (bool success,) = to.call{value: amount}("");
        require(success, EtherTransferFailed());
    }

    /// Transfers token to an address
    /// @dev This function reverts if transferring the tokens fails
    /// @dev This function supports non standard ERC20 tokens that have a "transfer" method that does not return a boolean
    /// @param token Address of the token
    /// @param to Address to which the tokens should be transferred
    /// @param value Amount of token that should be transferred in the smallest denomination of the token
    function safeTransferToken(address token, address to, uint256 value) internal {
        // bytes4(keccak256(bytes('transfer(address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), TokenTransferFailed());
    }

    /// Transfers token from one address to another
    /// @dev This function reverts if transferring the tokens fails
    /// @dev This function supports non standard ERC20 tokens that have a "transferFrom" method that does not return a boolean
    /// @dev Keep in mind that "transferFrom" requires an allowance of the "from" address for the caller that is equal or greater than the "value"
    /// @param token Address of the token
    /// @param from Address from which the tokens should be transferred
    /// @param to Address to which the tokens should be transferred
    /// @param value Amount of token that should be transferred in the smallest denomination of the token
    function safeTransferTokenFrom(address token, address from, address to, uint256 value) internal {
        // bytes4(keccak256(bytes('transferFrom(address,address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), TokenTransferFromFailed());
    }
}
