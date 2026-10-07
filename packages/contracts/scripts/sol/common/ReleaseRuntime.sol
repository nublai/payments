// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployHelper} from "./DeployHelper.s.sol";
import {LibString} from "solady/utils/LibString.sol";

interface IReleaseAccount {
    function ORCHESTRATOR() external view returns (address);
}

interface IReleaseOApp {
    function endpoint() external view returns (address);
}

/// @title ReleaseRuntime
/// @notice Compares on-chain code to the release artifact, immutables included.
/// @dev The masked compare zeroes every immutableReferences span, so it cannot see
/// Account.ORCHESTRATOR or LayerZeroSettler.endpoint. After a masked match, the exact
/// compare runs the release creation code with the expected constructor args at the
/// same address and requires the returned runtime byte for byte. That also pins the
/// Solady EIP-712 immutables (address(this), chain id, name, version, separator).
abstract contract ReleaseRuntime is DeployHelper {
    using LibString for string;

    address internal constant RELEASE_CREATE2_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function _releaseArtifact(string memory name) internal pure returns (string memory) {
        return string.concat("out/", name, ".sol/", name, ".json");
    }

    /// @notice True when on-chain runtime matches the release artifact with immutables masked.
    /// @dev A raw extcodehash false-fails Solady EIP-712 contracts, whose immutables
    /// include the chain id.
    function _runtimeMatchesRelease(
        address instance,
        string memory name
    ) internal returns (bool) {
        if (instance == address(0) || instance.code.length == 0) return false;
        string[] memory args = new string[](4);
        args[0] = "python3";
        args[1] = "scripts/sh/match-release-runtime.py";
        args[2] = _releaseArtifact(name);
        args[3] = vm.toString(instance.code);
        return keccak256(vm.ffi(args)) == keccak256(bytes("match"));
    }

    /// @notice True when on-chain runtime equals the release runtime built with `args`.
    /// @dev Must run outside broadcast. State is restored before returning.
    function _runtimeMatchesReleaseExactly(
        address instance,
        string memory name,
        bytes memory args
    ) internal returns (bool) {
        if (instance == address(0) || instance.code.length == 0) return false;
        bytes32 onChain = keccak256(instance.code);
        bytes memory initCode = bytes.concat(vm.getCode(_releaseArtifact(name)), args);
        uint256 snapshot = vm.snapshotState();
        vm.etch(instance, initCode);
        (bool ok, bytes memory runtime) = instance.call("");
        vm.revertToStateAndDelete(snapshot);
        return ok && keccak256(runtime) == onChain;
    }

    /// @notice Revert unless the trusted immutables and the full runtime are the expected values.
    /// @dev Call only after a masked match, so the getters exist.
    function _requireExpectedImmutables(
        address instance,
        string memory name,
        bytes memory args
    ) internal {
        if (name.eq("Account")) {
            address expected = abi.decode(args, (address));
            address actual = IReleaseAccount(instance).ORCHESTRATOR();
            if (actual != expected) {
                revert(
                    string.concat(
                        "Account.ORCHESTRATOR() at ",
                        vm.toString(instance),
                        " is ",
                        vm.toString(actual),
                        ", not the verified release Orchestrator ",
                        vm.toString(expected)
                    )
                );
            }
        } else if (name.eq("LayerZeroSettler")) {
            (address expected, , ) = abi.decode(args, (address, address, address));
            address actual = IReleaseOApp(instance).endpoint();
            if (actual != expected) {
                revert(
                    string.concat(
                        "LayerZeroSettler.endpoint() at ",
                        vm.toString(instance),
                        " is ",
                        vm.toString(actual),
                        ", not the expected endpoint ",
                        vm.toString(expected)
                    )
                );
            }
        }
        if (!_runtimeMatchesReleaseExactly(instance, name, args)) {
            revert(
                string.concat(
                    name,
                    " at ",
                    vm.toString(instance),
                    " immutables do not match the expected values"
                )
            );
        }
    }

    /// @notice Revert unless the deployed runtime is the release artifact with the expected immutables.
    function _requireReleaseRuntime(
        address instance,
        string memory name,
        bytes memory args
    ) internal {
        if (!_runtimeMatchesRelease(instance, name)) {
            revert(string.concat(name, " runtime does not match the release artifact"));
        }
        _requireExpectedImmutables(instance, name, args);
    }

    /// @notice LZ_ENDPOINT, which must be the LayerZero V2 endpoint on chains listed here.
    function _expectedLzEndpoint() internal view returns (address endpoint) {
        endpoint = vm.envOr("LZ_ENDPOINT", address(0));
        require(endpoint != address(0), "LZ_ENDPOINT not set");
        address canonical = _canonicalLzEndpoint(block.chainid);
        if (canonical != address(0) && endpoint != canonical) {
            revert(
                string.concat(
                    "LZ_ENDPOINT ",
                    vm.toString(endpoint),
                    " is not the LayerZero V2 endpoint ",
                    vm.toString(canonical),
                    " for this chain"
                )
            );
        }
    }

    function _canonicalLzEndpoint(uint256 chainId) internal pure returns (address) {
        if (chainId == 8453 || chainId == 42_161 || chainId == 137) {
            return 0x1a44076050125825900e736c501f859c50fE728c;
        }
        if (chainId == 84_532) return 0x6EDCE65403992e310A62460808c4b910D972f10f;
        return address(0);
    }

    function _releaseCreate2Address(string memory name) internal view returns (address) {
        return
            vm.computeCreate2Address(
                bytes32(0),
                keccak256(vm.getCode(_releaseArtifact(name))),
                RELEASE_CREATE2_FACTORY
            );
    }

    /// @notice Try to read deployment address, returns address(0) if file doesn't exist
    function _tryReadDeploymentAddress(
        uint256 chainId,
        string memory contractName
    ) internal view returns (address) {
        string memory dirPath = _getDeploymentDir(chainId);
        string memory path = string.concat(dirPath, "/", contractName, ".json");

        if (!vm.exists(path)) return address(0);

        string memory json = vm.readFile(path);
        return vm.parseJsonAddress(json, ".address");
    }
}
