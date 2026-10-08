// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ReleaseRuntime} from "./common/ReleaseRuntime.sol";
import {console} from "forge-std/console.sol";
import {LibEIP7702} from "solady/accounts/LibEIP7702.sol";

/// @title VerifyRelease
/// @notice Post-broadcast check of deployments/envs/{context}/{chainId}. Read-only.
/// @dev Zero addresses and empty code are skipped, as in deploy.sh. Account is checked
/// against the release Orchestrator verified here; AccountProxy against that Account.
contract VerifyRelease is ReleaseRuntime {
    function run(uint256 chainId) external {
        require(block.chainid == chainId, "Chain ID mismatch");

        address orchestrator = _verifiedOrchestrator(chainId);
        _verifyNoArg(chainId, "orchestrator", "Orchestrator");
        _verifyNoArg(chainId, "simulator", "Simulator");
        _verifyNoArg(chainId, "escrow", "Escrow");
        _verifyNoArg(chainId, "multiSigSigner", "MultiSigSigner");

        address account = _deployed(chainId, "account");
        if (account != address(0)) {
            require(orchestrator != address(0), "Account has no verified release Orchestrator");
            _requireReleaseRuntime(account, "Account", abi.encode(orchestrator));
            _logVerified("Account", account);
        }

        address proxy = _deployed(chainId, "accountProxy");
        if (proxy != address(0)) {
            require(account != address(0), "AccountProxy has no verified release Account");
            require(LibEIP7702.isEIP7702Proxy(proxy), "AccountProxy is not an EIP7702Proxy");
            require(LibEIP7702.proxyAdmin(proxy) == address(0), "AccountProxy has an admin");
            address implementation = LibEIP7702.implementationOf(proxy);
            if (implementation != account) {
                revert(
                    string.concat(
                        "AccountProxy implementation ",
                        vm.toString(implementation),
                        " is not the verified release Account ",
                        vm.toString(account)
                    )
                );
            }
            console.log("  implementation is the verified release Account: AccountProxy", proxy);
        }

        address owner = vm.envOr("DEPLOYER_ADDRESS", msg.sender);
        address funder = _deployed(chainId, "simpleFunder");
        if (funder != address(0)) {
            bytes memory args = abi.encode(vm.envOr("FUNDER", msg.sender), owner);
            _requireReleaseRuntime(funder, "SimpleFunder", args);
            _logVerified("SimpleFunder", funder);
        }
        address settler = _deployed(chainId, "simpleSettler");
        if (settler != address(0)) {
            _requireReleaseRuntime(settler, "SimpleSettler", abi.encode(owner));
            _logVerified("SimpleSettler", settler);
        }
        address lzSettler = _deployed(chainId, "layerZeroSettler");
        if (lzSettler != address(0)) {
            address signer = vm.envOr("LZ_SETTLER_SIGNER", address(0));
            bytes memory args = abi.encode(_expectedLzEndpoint(), owner, signer);
            _requireReleaseRuntime(lzSettler, "LayerZeroSettler", args);
            _logVerified("LayerZeroSettler", lzSettler);
        }
    }

    /// @dev Same order as DeployUnified._getExistingOrDeploy: CREATE2 address, then JSON.
    function _verifiedOrchestrator(uint256 chainId) internal returns (address) {
        address predicted = _releaseCreate2Address("Orchestrator");
        if (predicted.code.length != 0) {
            _requireReleaseRuntime(predicted, "Orchestrator", "");
            return predicted;
        }
        address file = _deployed(chainId, "orchestrator");
        if (file != address(0)) {
            _requireReleaseRuntime(file, "Orchestrator", "");
        }
        return file;
    }

    function _verifyNoArg(uint256 chainId, string memory stem, string memory name) internal {
        address instance = _deployed(chainId, stem);
        if (instance == address(0)) return;
        _requireReleaseRuntime(instance, name, "");
        _logVerified(name, instance);
    }

    function _deployed(uint256 chainId, string memory stem) internal view returns (address) {
        address instance = _tryReadDeploymentAddress(chainId, stem);
        if (instance == address(0) || instance.code.length == 0) return address(0);
        return instance;
    }

    function _logVerified(string memory name, address instance) internal pure {
        console.log("  immutables match the expected values:", name, instance);
    }
}
