// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @dev WARNING! This mock is strictly intended for testing purposes only.
/// Do NOT copy anything here into production code unless you really know what you are doing.
contract MockPaymentToken is ERC20 {
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }

    function anotherTransfer(address to, uint256 amount) public returns (bool) {
        transfer(to, amount);
        return true;
    }

    /// @dev OpenZeppelin-style allowance increment. Production tokens such as USDC expose this.
    function increaseAllowance(address spender, uint256 addedValue) public returns (bool) {
        return approve(spender, allowance(msg.sender, spender) + addedValue);
    }

    /// @dev Older DAI-style allowance increment. Same accounting shape as `increaseAllowance`.
    function increaseApproval(address spender, uint256 addedValue) public returns (bool) {
        return approve(spender, allowance(msg.sender, spender) + addedValue);
    }

    function name() public view virtual override returns (string memory) {
        return "Name";
    }

    function symbol() public view virtual override returns (string memory) {
        return "SYM";
    }
}
