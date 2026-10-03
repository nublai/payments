// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @dev Mock USDC for local testing. Has 6 decimals like real USDC.
/// WARNING! This mock is strictly intended for testing purposes only.
contract MockUSDC is ERC20 {
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }

    function name() public view virtual override returns (string memory) {
        return "USD Coin";
    }

    function symbol() public view virtual override returns (string memory) {
        return "USDC";
    }

    function decimals() public view virtual override returns (uint8) {
        return 6;
    }
}
