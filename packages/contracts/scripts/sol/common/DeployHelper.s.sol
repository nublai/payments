// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/// @title DeployHelper
/// @notice Abstract contract providing deployment utilities
/// @dev Handles JSON file writing for deployment addresses
abstract contract DeployHelper is Script {
    /// @notice Get the envs directory path (raw build envs)
    /// @param chainId The chain ID
    /// @return dirPath The directory path: deployments/envs/{context}/{chainId}
    function _getDeploymentDir(uint256 chainId) internal view returns (string memory) {
        string memory context = vm.envOr("DEPLOYMENT_CONTEXT", string("local"));
        return string.concat("deployments/envs/", context, "/", vm.toString(chainId));
    }

    /// @notice Write a single contract deployment to its own JSON file
    /// @param chainId The chain ID
    /// @param contractName The contract name (used for filename)
    /// @param contractAddress The deployed contract address
    function _writeContractDeployment(
        uint256 chainId,
        string memory contractName,
        address contractAddress
    ) internal {
        string memory dirPath = _getDeploymentDir(chainId);

        // Build file path: deployments/envs/{context}/{chainId}/{contractName}.json
        string memory path = string.concat(dirPath, "/", contractName, ".json");

        // Create JSON with address
        string memory json = vm.serializeAddress(contractName, "address", contractAddress);

        _writeDeployment(json, path, dirPath);
    }

    /// @notice Write deployment JSON to file
    /// @param json The serialized JSON string
    /// @param path The file path to write to
    /// @param dirPath The directory path (parent of file)
    function _writeDeployment(
        string memory json,
        string memory path,
        string memory dirPath
    ) internal {
        // Create parent directories using ffi
        string[] memory mkdirCmd = new string[](3);
        mkdirCmd[0] = "mkdir";
        mkdirCmd[1] = "-p";
        mkdirCmd[2] = dirPath;
        vm.ffi(mkdirCmd);

        // Write the JSON file
        vm.writeFile(path, json);
        console2.log("Deployment written to:", path);
    }

    /// @notice Read a deployment address from JSON file
    /// @param chainId The chain ID to read from
    /// @param contractName The contract name (e.g., "orchestrator")
    /// @return The address stored in that contract's JSON file
    function _readDeploymentAddress(
        uint256 chainId,
        string memory contractName
    ) internal view returns (address) {
        string memory dirPath = _getDeploymentDir(chainId);
        string memory path = string.concat(dirPath, "/", contractName, ".json");

        string memory json = vm.readFile(path);
        return vm.parseJsonAddress(json, ".address");
    }
}
