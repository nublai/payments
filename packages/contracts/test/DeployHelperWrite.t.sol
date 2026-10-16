// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployHelper} from "../scripts/sol/common/DeployHelper.s.sol";

contract DeployHelperHarness is DeployHelper {
    function write(uint256 chainId, string memory name, address addr) external {
        _writeContractDeployment(chainId, name, addr);
    }

    function dirOf(uint256 chainId) external view returns (string memory) {
        return _getDeploymentDir(chainId);
    }
}

/// @dev deploy.sh writes through DeployHelper. A fresh stage/84532 deploy
/// must create `deployments/envs/<context>/<chainId>` when those dirs are absent.
contract DeployHelperWriteTest is Test {
    string internal constant CONTEXT = "local-mkdir-test";

    function testWriteCreatesMissingDirectory() public {
        vm.setEnv("DEPLOYMENT_CONTEXT", CONTEXT);
        vm.setEnv("SAVE_DEPLOYMENTS", "true");
        DeployHelperHarness helper = new DeployHelperHarness();
        uint256 chainId = 84_532;
        string memory dir = helper.dirOf(chainId);
        if (vm.exists(dir)) {
            vm.removeDir(dir, true);
        }

        address expected = address(0xE6CfdB399efdc88FA11964072AB519c65c044130);
        helper.write(chainId, "orchestrator", expected);

        string memory path = string.concat(dir, "/orchestrator.json");
        assertTrue(vm.exists(path), "deploy write must create missing envs/<context>/<chainId>");
        assertEq(vm.parseJsonAddress(vm.readFile(path), ".address"), expected);

        vm.removeDir(string.concat("deployments/envs/", CONTEXT), true);
    }
}
