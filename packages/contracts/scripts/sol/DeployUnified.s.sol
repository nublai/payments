// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeployFacetWithArgs} from "./common/DeployFacetWithArgs.sol";
import {ReleaseRuntime} from "./common/ReleaseRuntime.sol";
// @towns-protocol/diamond is an upstream package, not this product's name.
import {DeployBase} from "@towns-protocol/diamond/scripts/common/DeployBase.s.sol";
import {console} from "forge-std/console.sol";
import {LibEIP7702} from "solady/accounts/LibEIP7702.sol";
import {LibString} from "solady/utils/LibString.sol";

// Contract imports for relayer setup
import {Orchestrator} from "src/accounts/Orchestrator.sol";
import {SimpleFunder} from "src/accounts/SimpleFunder.sol";

/// @title DeployUnified
/// @notice Unified deployment script for the Account system
/// @dev Uses environment variables for all configuration
contract DeployUnified is DeployBase, ReleaseRuntime {
    using LibString for string;

    /// @dev Our extended deployer with constructor args support
    DeployFacetWithArgs internal deployer = new DeployFacetWithArgs();

    /// @dev Deployed AccountProxy address (handled separately via LibEIP7702)
    address internal accountProxy;

    /// @notice Main entry point - deploys to specified chains
    /// @param chainIds Array of chain IDs to deploy to
    function run(uint256[] calldata chainIds) external {
        // Make deployer persistent across forks
        vm.makePersistent(address(deployer));

        for (uint256 i; i < chainIds.length; i++) {
            _deployToChain(chainIds[i]);
        }
    }

    /// @notice Deploy all contracts to a single chain
    /// @param chainId The chain ID to deploy to
    function _deployToChain(uint256 chainId) internal {
        // Clear any previous state
        deployer.clearAllQueues();
        accountProxy = address(0);

        console.log("\n=====================================");
        console.log("Deploying to chain:", chainId);
        console.log("=====================================\n");

        // Fork to target chain using RPC_URL env var
        string memory rpcUrl = vm.envString("RPC_URL");
        vm.createSelectFork(rpcUrl);
        require(block.chainid == chainId, "Chain ID mismatch");

        address deployerAddr = msg.sender;

        // =========================================================
        // PHASE 1: No-arg contracts (batched via CREATE2)
        // =========================================================
        console.log("Phase 1: Deploying no-arg contracts...");
        deployer.add("Orchestrator");
        deployer.add("Simulator");
        deployer.add("Escrow");
        deployer.add("MultiSigSigner");
        deployer.deployBatch(deployerAddr);

        // Cache addresses
        address orchestrator = deployer.getDeployedAddress("Orchestrator");
        console.log("  Orchestrator:", orchestrator);
        _requireReleaseRuntime(orchestrator, "Orchestrator", "");
        _requireReleaseRuntime(deployer.getDeployedAddress("Simulator"), "Simulator", "");
        _requireReleaseRuntime(deployer.getDeployedAddress("Escrow"), "Escrow", "");
        _requireReleaseRuntime(
            deployer.getDeployedAddress("MultiSigSigner"),
            "MultiSigSigner",
            ""
        );

        // =========================================================
        // PHASE 2: Account (depends on Orchestrator)
        // =========================================================
        console.log("\nPhase 2: Deploying Account...");
        deployer.addWithArgs("Account", abi.encode(orchestrator));
        deployer.deployArgsQueue(deployerAddr);

        address account = deployer.getDeployedAddressWithArgs("Account");
        console.log("  Account:", account);
        _requireReleaseRuntime(account, "Account", abi.encode(orchestrator));

        // =========================================================
        // PHASE 3: AccountProxy (LibEIP7702, not CREATE2)
        // =========================================================
        console.log("\nPhase 3: Deploying AccountProxy...");
        vm.startBroadcast(deployerAddr);
        accountProxy = LibEIP7702.deployProxy(account, address(0));
        vm.stopBroadcast();
        console.log("  AccountProxy:", accountProxy);

        // =========================================================
        // PHASE 4: Config-driven contracts
        // =========================================================
        console.log("\nPhase 4: Deploying config-driven contracts...");

        // SimpleFunder
        address funderAddr = _getEnvAddressOrDefault("FUNDER", deployerAddr);
        address funderOwner = _owner(deployerAddr);
        bytes memory funderArgs = abi.encode(funderAddr, funderOwner);
        deployer.addWithArgs("SimpleFunder", funderArgs);

        // SimpleSettler
        address settlerOwner = _owner(deployerAddr);
        bytes memory settlerArgs = abi.encode(settlerOwner);
        deployer.addWithArgs("SimpleSettler", settlerArgs);

        // LayerZeroSettler (optional - only if endpoint is configured)
        bytes memory lzArgs;
        if (vm.envOr("LZ_ENDPOINT", address(0)) != address(0)) {
            address lzSigner = _lzSigner();
            address lzOwner = _owner(deployerAddr);
            lzArgs = abi.encode(_expectedLzEndpoint(), lzOwner, lzSigner);
            deployer.addWithArgs("LayerZeroSettler", lzArgs);
        }

        deployer.deployArgsQueue(deployerAddr);

        address simpleFunder = deployer.getDeployedAddressWithArgs("SimpleFunder");
        address simpleSettler = deployer.getDeployedAddressWithArgs("SimpleSettler");
        console.log("  SimpleFunder:", simpleFunder);
        console.log("  SimpleSettler:", simpleSettler);
        _requireReleaseRuntime(simpleFunder, "SimpleFunder", funderArgs);
        _requireReleaseRuntime(simpleSettler, "SimpleSettler", settlerArgs);

        address lzSettler = deployer.getDeployedAddressWithArgs("LayerZeroSettler");
        if (lzSettler != address(0)) {
            console.log("  LayerZeroSettler:", lzSettler);
            _requireReleaseRuntime(lzSettler, "LayerZeroSettler", lzArgs);
        }

        // =========================================================
        // PHASE 5: Relayer setup (if mnemonic configured)
        // =========================================================
        _setupRelayerIfConfigured(chainId, orchestrator, deployerAddr);

        // =========================================================
        // PHASE 6: Save all deployments
        // =========================================================
        console.log("\nPhase 6: Saving deployments...");
        _saveAllDeployments(chainId);

        console.log(unicode"\n✅ Deployment complete for chain", chainId);
    }

    /// @notice Get env address or return default if not set
    function _getEnvAddressOrDefault(
        string memory key,
        address defaultAddr
    ) internal view returns (address) {
        return vm.envOr(key, defaultAddr);
    }

    /// @notice Owner for SimpleFunder, SimpleSettler, and LayerZeroSettler (DEPLOYER_ADDRESS).
    /// @dev Outside local chains the owner must be set and must not be the hot deployer
    /// or funder key. Local Anvil defaults the owner to the deployer.
    function _owner(address deployerAddr) internal view returns (address owner) {
        owner = vm.envOr("DEPLOYER_ADDRESS", address(0));
        if (block.chainid == 31_337 || block.chainid == 41_337) {
            return owner == address(0) ? deployerAddr : owner;
        }
        require(owner != address(0), "owner not set: pass --owner outside local");
        require(owner != deployerAddr, "owner equals the deployer address");
        require(
            owner != _getEnvAddressOrDefault("FUNDER", deployerAddr),
            "owner equals the funder address"
        );
    }

    function _lzSigner() internal view returns (address signer) {
        signer = vm.envOr("LZ_SETTLER_SIGNER", address(0));
        require(signer != address(0), "LZ_SETTLER_SIGNER is the zero address");
    }

    /// @notice Setup relayer if RELAYER_MNEMONIC is configured
    function _setupRelayerIfConfigured(
        uint256 chainId,
        address orchestrator,
        address deployerAddr
    ) internal {
        string memory mnemonic = vm.envOr("RELAYER_MNEMONIC", string(""));
        if (bytes(mnemonic).length == 0) {
            console.log("\nPhase 5: Skipped - RELAYER_MNEMONIC not set");
            return;
        }

        uint256 relayerCount = vm.envOr("RELAYER_COUNT", uint256(10));
        console.log("\nPhase 5: Setting up relayer...");
        console.log("  Signer count:", relayerCount);

        SimpleFunder simpleFunder = SimpleFunder(
            payable(deployer.getDeployedAddressWithArgs("SimpleFunder"))
        );

        // Derive signer addresses from mnemonic (outside broadcast)
        address[] memory signers = new address[](relayerCount);
        for (uint256 i = 0; i < relayerCount; i++) {
            uint256 privateKey = vm.deriveKey(mnemonic, uint32(i));
            signers[i] = vm.addr(privateKey);
            console.log("    Signer", i, ":", signers[i]);
        }

        vm.startBroadcast(deployerAddr);

        // Whitelist signers as gas wallets
        console.log("  Whitelisting signers as gas wallets...");
        simpleFunder.setGasWallet(signers, true);

        // Whitelist orchestrator
        console.log("  Whitelisting orchestrator...");
        address[] memory orchestrators = new address[](1);
        orchestrators[0] = orchestrator;
        simpleFunder.setOrchestrators(orchestrators, true);

        // Fund SimpleFunder on local dev (chain 31337)
        if (chainId == 31_337) {
            uint256 fundAmount = 10 ether;
            console.log("  Funding SimpleFunder with", fundAmount / 1 ether, "ETH...");
            (bool success, ) = address(simpleFunder).call{value: fundAmount}("");
            require(success, "Failed to fund SimpleFunder");
        }

        vm.stopBroadcast();

        console.log("  Relayer setup complete!");
    }

    /// @notice Save all deployed contract addresses to JSON files
    function _saveAllDeployments(uint256 chainId) internal {
        _writeContractDeployment(
            chainId,
            "orchestrator",
            deployer.getDeployedAddress("Orchestrator")
        );
        _writeContractDeployment(
            chainId,
            "account",
            deployer.getDeployedAddressWithArgs("Account")
        );
        _writeContractDeployment(chainId, "accountProxy", accountProxy);
        _writeContractDeployment(chainId, "simulator", deployer.getDeployedAddress("Simulator"));
        _writeContractDeployment(
            chainId,
            "simpleFunder",
            deployer.getDeployedAddressWithArgs("SimpleFunder")
        );
        _writeContractDeployment(
            chainId,
            "simpleSettler",
            deployer.getDeployedAddressWithArgs("SimpleSettler")
        );
        _writeContractDeployment(chainId, "escrow", deployer.getDeployedAddress("Escrow"));
        _writeContractDeployment(
            chainId,
            "multiSigSigner",
            deployer.getDeployedAddress("MultiSigSigner")
        );

        // LayerZeroSettler (if deployed)
        address lzSettler = deployer.getDeployedAddressWithArgs("LayerZeroSettler");
        if (lzSettler != address(0)) {
            _writeContractDeployment(chainId, "layerZeroSettler", lzSettler);
        }

        console.log("  Deployments saved to deployments/envs/");
    }

    // =========================================================================
    // SELECTIVE DEPLOYMENT
    // =========================================================================

    /// @notice Deploy specific contracts to specified chains
    /// @param chainIds Array of chain IDs to deploy to
    /// @param contractNames Comma-separated contract names (e.g., "SimpleFunder,SimpleSettler")
    function runSelective(uint256[] calldata chainIds, string calldata contractNames) external {
        // Make deployer persistent across forks
        vm.makePersistent(address(deployer));

        // Parse contract names into array
        string[] memory contracts = _parseContractNames(contractNames);

        for (uint256 i; i < chainIds.length; i++) {
            _deploySelectiveToChain(chainIds[i], contracts);
        }
    }

    /// @notice Deploy only specified contracts to a chain
    function _deploySelectiveToChain(uint256 chainId, string[] memory contracts) internal {
        deployer.clearAllQueues();

        console.log("\n=====================================");
        console.log("Selective deploy to chain:", chainId);
        console.log("Contracts:", contracts.length);
        console.log("=====================================\n");

        string memory rpcUrl = vm.envString("RPC_URL");
        vm.createSelectFork(rpcUrl);
        require(block.chainid == chainId, "Chain ID mismatch");

        address deployerAddr = msg.sender;

        for (uint256 i; i < contracts.length; i++) {
            console.log("Deploying:", contracts[i]);
            _deployContract(chainId, contracts[i], deployerAddr);
        }

        console.log(unicode"\n✅ Selective deployment complete for chain", chainId);
    }

    /// @notice Deploy a single contract by name
    function _deployContract(uint256 chainId, string memory name, address deployerAddr) internal {
        // No-arg contracts
        if (
            name.eq("Orchestrator") ||
            name.eq("Simulator") ||
            name.eq("Escrow") ||
            name.eq("MultiSigSigner")
        ) {
            deployer.add(name);
            deployer.deployBatch(deployerAddr);
            address deployed = deployer.getDeployedAddress(name);
            _requireReleaseRuntime(deployed, name, "");
            _writeContractDeployment(chainId, _toLowerFirst(name), deployed);
            console.log("  Deployed at:", deployed);
        }
        // Account - needs Orchestrator
        else if (name.eq("Account")) {
            address orchestrator = _getExistingOrDeploy(chainId, "Orchestrator", deployerAddr);
            bytes memory args = abi.encode(orchestrator);
            deployer.addWithArgs("Account", args);
            deployer.deployArgsQueue(deployerAddr);
            address deployed = deployer.getDeployedAddressWithArgs("Account");
            _requireReleaseRuntime(deployed, "Account", args);
            _writeContractDeployment(chainId, "account", deployed);
            console.log("  Deployed at:", deployed);
        }
        // AccountProxy - needs Account
        else if (name.eq("AccountProxy")) {
            address account = _getExistingOrDeploy(chainId, "Account", deployerAddr);
            vm.startBroadcast(deployerAddr);
            address proxy = LibEIP7702.deployProxy(account, address(0));
            vm.stopBroadcast();
            _writeContractDeployment(chainId, "accountProxy", proxy);
            console.log("  Deployed at:", proxy);
        }
        // SimpleFunder - uses env vars
        else if (name.eq("SimpleFunder")) {
            address funder = _getEnvAddressOrDefault("FUNDER", deployerAddr);
            address owner = _owner(deployerAddr);
            bytes memory args = abi.encode(funder, owner);
            deployer.addWithArgs("SimpleFunder", args);
            deployer.deployArgsQueue(deployerAddr);
            address deployed = deployer.getDeployedAddressWithArgs("SimpleFunder");
            _requireReleaseRuntime(deployed, "SimpleFunder", args);
            _writeContractDeployment(chainId, "simpleFunder", deployed);
            console.log("  Deployed at:", deployed);
        }
        // SimpleSettler - uses env vars
        else if (name.eq("SimpleSettler")) {
            address owner = _owner(deployerAddr);
            bytes memory args = abi.encode(owner);
            deployer.addWithArgs("SimpleSettler", args);
            deployer.deployArgsQueue(deployerAddr);
            address deployed = deployer.getDeployedAddressWithArgs("SimpleSettler");
            _requireReleaseRuntime(deployed, "SimpleSettler", args);
            _writeContractDeployment(chainId, "simpleSettler", deployed);
            console.log("  Deployed at:", deployed);
        }
        // LayerZeroSettler - uses env vars
        else if (name.eq("LayerZeroSettler")) {
            address endpoint = _expectedLzEndpoint();
            address signer = _lzSigner();
            address owner = _owner(deployerAddr);
            bytes memory args = abi.encode(endpoint, owner, signer);
            deployer.addWithArgs("LayerZeroSettler", args);
            deployer.deployArgsQueue(deployerAddr);
            address deployed = deployer.getDeployedAddressWithArgs("LayerZeroSettler");
            _requireReleaseRuntime(deployed, "LayerZeroSettler", args);
            _writeContractDeployment(chainId, "layerZeroSettler", deployed);
            console.log("  Deployed at:", deployed);
        } else {
            revert(string.concat("Unknown contract: ", name));
        }
    }

    /// @notice Get existing deployed address or deploy the contract.
    /// A JSON address is used only when its code matches the release artifact.
    /// Code already at the CREATE2 address that does not match cannot be replaced.
    /// Reused code whose immutables differ from the expected values reverts.
    function _getExistingOrDeploy(
        uint256 chainId,
        string memory name,
        address deployerAddr
    ) internal returns (address) {
        address existing = deployer.getDeployedAddress(name);
        if (existing != address(0)) {
            if (!_runtimeMatchesRelease(existing, name)) {
                revert(
                    string.concat(name, " at CREATE2 address does not match the release artifact")
                );
            }
            _requireExpectedImmutables(existing, name, _dependencyArgs(chainId, name, deployerAddr));
            console.log("  Found existing (CREATE2):", name, existing);
            return existing;
        }

        existing = _tryReadDeploymentAddress(chainId, _toLowerFirst(name));
        if (existing != address(0) && _runtimeMatchesRelease(existing, name)) {
            _requireExpectedImmutables(existing, name, _dependencyArgs(chainId, name, deployerAddr));
            console.log("  Found existing (file):", name, existing);
            deployer.cacheDeployedAddress(name, existing);
            return existing;
        }
        if (existing != address(0)) {
            console.log(
                "  Ignoring deployment file; on-chain code does not match the release artifact"
            );
            console.log("   ", name, existing);
        }

        console.log("  Deploying dependency:", name);
        _deployContract(chainId, name, deployerAddr);

        address deployed = deployer.getDeployedAddress(name);
        if (deployed != address(0)) return deployed;
        return deployer.getDeployedAddressWithArgs(name);
    }

    /// @notice Constructor args a reused dependency must have been built with.
    /// @dev Account's Orchestrator is itself resolved and verified first.
    function _dependencyArgs(
        uint256 chainId,
        string memory name,
        address deployerAddr
    ) internal returns (bytes memory) {
        if (
            name.eq("Orchestrator") ||
            name.eq("Simulator") ||
            name.eq("Escrow") ||
            name.eq("MultiSigSigner")
        ) {
            return "";
        }
        if (name.eq("Account")) {
            return abi.encode(_getExistingOrDeploy(chainId, "Orchestrator", deployerAddr));
        }
        revert(string.concat("No expected constructor args for dependency ", name));
    }

    /// @notice Parse comma-separated contract names into array
    function _parseContractNames(string memory names) internal pure returns (string[] memory) {
        // Count commas to determine array size
        bytes memory b = bytes(names);
        uint256 count = 1;
        for (uint256 i; i < b.length; i++) {
            if (b[i] == ",") count++;
        }

        string[] memory result = new string[](count);
        uint256 idx;
        uint256 start;

        for (uint256 i; i < b.length; i++) {
            if (b[i] == ",") {
                result[idx] = _substring(names, start, i);
                idx++;
                start = i + 1;
            }
        }
        // Last segment
        result[idx] = _substring(names, start, b.length);

        return result;
    }

    /// @notice Extract substring from string
    function _substring(
        string memory str,
        uint256 startIndex,
        uint256 endIndex
    ) internal pure returns (string memory) {
        bytes memory strBytes = bytes(str);
        bytes memory result = new bytes(endIndex - startIndex);
        for (uint256 i = startIndex; i < endIndex; i++) {
            result[i - startIndex] = strBytes[i];
        }
        return string(result);
    }

    /// @notice Convert first character to lowercase (e.g., "Orchestrator" -> "orchestrator")
    /// @dev Copies the bytes. `bytes(str)` aliases the argument, so an in-place edit
    /// would also change the contract name used for the dependency deploy.
    function _toLowerFirst(string memory str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        bytes memory copy = new bytes(b.length);
        for (uint256 i; i < b.length; i++) {
            copy[i] = b[i];
        }
        if (copy.length != 0 && copy[0] >= 0x41 && copy[0] <= 0x5A) {
            copy[0] = bytes1(uint8(copy[0]) + 32);
        }
        return string(copy);
    }
}
