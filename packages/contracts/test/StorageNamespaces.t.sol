// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import {Test} from "forge-std/Test.sol";
import {Account as AgenticAccount} from "../src/accounts/Account.sol";

contract StorageNamespaceHarness is AgenticAccount {
    constructor() AgenticAccount(address(1)) {}

    function accountStorageSlot() external pure returns (uint256 s) {
        AccountStorage storage $ = _getAccountStorage();
        assembly ("memory-safe") {
            s := $.slot
        }
    }

    function upgradeHookId() external pure returns (bytes32) {
        return _UPGRADE_HOOK_ID;
    }

    function guardedExecutorKeyStorageNamespace() external pure returns (uint256) {
        return _GUARDED_EXECUTOR_KEY_STORAGE;
    }

    function guardedExecutorKeyStorageSlot(bytes32 keyHash) external view returns (uint256 s) {
        GuardedExecutorKeyStorage storage $ = _getGuardedExecutorKeyStorage(keyHash);
        assembly ("memory-safe") {
            s := $.slot
        }
    }

    function upgradeHookGuardTransientSlot() external pure returns (bytes32) {
        return _UPGRADE_HOOK_GUARD_TRANSIENT_SLOT;
    }

    function keyHashStackTransientSlot() external pure returns (uint256) {
        return _KEYHASH_STACK_TRANSIENT_SLOT;
    }

    function guardedBatchTransientSlot() external pure returns (bytes32) {
        return _GUARDED_BATCH_TRANSIENT_SLOT;
    }
}

contract StorageNamespaceTest is Test {
    StorageNamespaceHarness internal harness;

    function setUp() public {
        harness = new StorageNamespaceHarness();
    }

    function testSlotConstantsMatchFormula() public view {
        assertEq(
            harness.accountStorageSlot(),
            uint256(uint72(bytes9(keccak256("NUBL_ACCOUNT_STORAGE"))))
        );
        assertEq(harness.accountStorageSlot(), 0xb5d4fb4fa1aabbe4d3);
        assertEq(harness.upgradeHookId(), keccak256("NUBL_ACCOUNT_UPGRADE_HOOK_ID"));
        assertEq(
            harness.upgradeHookId(),
            0x5f13e044594e776e415555b0dfce237fb9e82e09c9a912a301b771e84e02c348
        );
        assertEq(
            harness.guardedExecutorKeyStorageNamespace(),
            uint256(uint72(bytes9(keccak256("NUBL_GUARDED_EXECUTOR_KEY_STORAGE"))))
        );
        assertEq(harness.guardedExecutorKeyStorageNamespace(), 0x1a5b89b7f7e5dfe4d0);
        assertEq(
            harness.upgradeHookGuardTransientSlot(),
            bytes32(uint256(keccak256("_UPGRADE_HOOK_GUARD_TRANSIENT_SLOT")) - 1)
        );
        assertEq(
            harness.keyHashStackTransientSlot(),
            uint256(keccak256("_KEYHASH_STACK_TRANSIENT_SLOT")) - 1
        );
        assertEq(
            harness.guardedBatchTransientSlot(),
            bytes32(uint256(keccak256("GUARDED_BATCH_TRANSIENT_SLOT")) - 1)
        );
    }

    function testGuardedExecutorSlotUsesNamespace() public view {
        bytes32 seed = harness.ANY_KEYHASH();
        uint256 namespaceHash = uint72(bytes9(keccak256("NUBL_GUARDED_EXECUTOR_KEY_STORAGE")));
        bytes32 expected;
        assembly ("memory-safe") {
            mstore(0x09, namespaceHash)
            mstore(0x00, seed)
            expected := keccak256(0x00, 0x29)
        }
        assertEq(harness.guardedExecutorKeyStorageSlot(seed), uint256(expected));
    }

    function testNamespacesDoNotContainTowns() public pure {
        _assertNoTowns("NUBL_ACCOUNT_STORAGE");
        _assertNoTowns("NUBL_ACCOUNT_UPGRADE_HOOK_ID");
        _assertNoTowns("NUBL_GUARDED_EXECUTOR_KEY_STORAGE");
        _assertNoTowns("_UPGRADE_HOOK_GUARD_TRANSIENT_SLOT");
        _assertNoTowns("_KEYHASH_STACK_TRANSIENT_SLOT");
        _assertNoTowns("GUARDED_BATCH_TRANSIENT_SLOT");
    }

    function testSrcNamespacesDoNotContainTowns() public {
        string[] memory cmd = new string[](2);
        cmd[0] = "python3";
        cmd[1] = "test/ffi/assert_no_towns_namespaces.py";
        vm.ffi(cmd);
    }

    function _assertNoTowns(string memory ns) internal pure {
        assertFalse(_containsTowns(ns), ns);
    }

    function _containsTowns(string memory ns) internal pure returns (bool) {
        bytes memory b = bytes(ns);
        if (b.length < 5) return false;
        for (uint256 i; i <= b.length - 5; ++i) {
            bool matched = true;
            for (uint256 j; j < 5; ++j) {
                uint8 c = uint8(b[i + j]);
                if (c >= 65 && c <= 90) c += 32;
                if (c != uint8(bytes("towns")[j])) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }
}
