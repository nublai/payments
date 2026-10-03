// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "../src/accounts/libraries/LibNonce.sol";
import "./Base.t.sol";
import "./utils/SoladyTest.sol";

contract LibNonceTest is BaseTest {
    mapping(uint192 => LibStorage.Ref) seqMap;

    function testCheckAndIncrementTypeUint256MaxNonceReverts() public {
        vm.expectRevert(LibNonce.InvalidNonce.selector);
        this.checkAndIncrementTypeUint256MaxNonce();
    }

    function checkAndIncrementTypeUint256MaxNonce() public {
        LibNonce.checkAndIncrement(seqMap, type(uint256).max);
    }
}
