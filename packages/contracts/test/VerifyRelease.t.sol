// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {LibEIP7702} from "solady/accounts/LibEIP7702.sol";
import {VerifyRelease} from "../scripts/sol/VerifyRelease.s.sol";

contract VerifyReleaseTest is Test {
    string internal constant CONTEXT = "verify-release-test";

    VerifyRelease internal verify;

    function setUp() public {
        verify = new VerifyRelease();
        vm.setEnv("DEPLOYMENT_CONTEXT", CONTEXT);
    }

    function testAccountProxyWithoutAdminPasses() public {
        string memory dir = _writeRelease(31_337_001, address(0));
        verify.run(block.chainid);
        vm.removeDir(dir, true);
    }

    function testAccountProxyWithAdminReverts() public {
        string memory dir = _writeRelease(31_337_002, address(0xBEEF));
        vm.expectRevert(bytes("AccountProxy has an admin"));
        verify.run(block.chainid);
        vm.removeDir(dir, true);
    }

    /// @dev Each test uses its own chain id so parallel tests write separate directories.
    function _writeRelease(uint256 chainId, address admin) internal returns (string memory dir) {
        vm.chainId(chainId);
        address orchestrator = deployCode("out/Orchestrator.sol/Orchestrator.json");
        address account = deployCode("out/Account.sol/Account.json", abi.encode(orchestrator));
        address proxy = LibEIP7702.deployProxy(account, admin);

        dir = string.concat("deployments/envs/", CONTEXT, "/", vm.toString(chainId));
        vm.createDir(dir, true);
        _write(dir, "orchestrator", orchestrator);
        _write(dir, "account", account);
        _write(dir, "accountProxy", proxy);
    }

    function _write(string memory dir, string memory stem, address instance) internal {
        string memory json = string.concat('{"address":"', vm.toString(instance), '"}');
        vm.writeFile(string.concat(dir, "/", stem, ".json"), json);
    }
}
