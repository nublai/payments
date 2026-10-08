// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {DeployUnified} from "../scripts/sol/DeployUnified.s.sol";

contract DeployUnifiedHarness is DeployUnified {
    function deployContract(uint256 chainId, string memory name, address deployerAddr) external {
        _deployContract(chainId, name, deployerAddr);
    }
}

/// @dev vm.setEnv is process-wide and tests run in parallel, so every test here
/// sets the same values in setUp. VerifyRelease.t.sol reads these keys with envOr.
contract DeployUnifiedTest is Test {
    uint256 internal constant BASE = 8453;
    address internal constant LZ_ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c;
    address internal constant OWNER = 0x000000000000000000000000000000000000a11c;
    address internal constant HOT = 0x000000000000000000000000000000000000b0b0;

    DeployUnifiedHarness internal harness;

    function setUp() public {
        vm.setEnv("IN_TESTING", "true");
        vm.setEnv("DEPLOYER_ADDRESS", vm.toString(OWNER));
        vm.setEnv("FUNDER", vm.toString(OWNER));
        vm.setEnv("LZ_ENDPOINT", vm.toString(LZ_ENDPOINT));
        vm.setEnv("LZ_SETTLER_SIGNER", vm.toString(address(0)));
        vm.chainId(BASE);
        vm.etch(LZ_ENDPOINT, hex"00");
        harness = new DeployUnifiedHarness();
    }

    function testSimpleSettlerRefusesOwnerEqualToDeployer() public {
        vm.expectRevert(bytes("owner equals the deployer address"));
        harness.deployContract(BASE, "SimpleSettler", OWNER);
    }

    function testSimpleFunderRefusesOwnerEqualToFunder() public {
        vm.expectRevert(bytes("owner equals the funder address"));
        harness.deployContract(BASE, "SimpleFunder", HOT);
    }

    function testLayerZeroSettlerRefusesZeroSigner() public {
        vm.expectRevert(bytes("LZ_SETTLER_SIGNER is the zero address"));
        harness.deployContract(BASE, "LayerZeroSettler", HOT);
    }
}
