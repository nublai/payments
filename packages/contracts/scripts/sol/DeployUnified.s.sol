// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {DeployFacetWithArgs} from "./common/DeployFacetWithArgs.sol";
import {DeployHelper} from "./common/DeployHelper.s.sol";
import {DeployBase} from "@towns-protocol/diamond/scripts/common/DeployBase.s.sol";
import {console} from "forge-std/console.sol";
import {LibEIP7702} from "solady/accounts/LibEIP7702.sol";
import {LibString} from "solady/utils/LibString.sol";

// Contract imports for relayer setup
import {Orchestrator} from "src/accounts/Orchestrator.sol";
import {SimpleFunder} from "src/accounts/SimpleFunder.sol";

/// @title DeployUnified
/// @notice Unified deployment script for the Towns Account system
/// @dev Uses environment variables for all configuration
contract DeployUnified is DeployBase, DeployHelper {
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

        // =========================================================
        // PHASE 2: TownsAccount (depends on Orchestrator)
        // =========================================================
        console.log("\nPhase 2: Deploying TownsAccount...");
        deployer.addWithArgs("TownsAccount", abi.encode(orchestrator));
        deployer.deployArgsQueue(deployerAddr);

        address townsAccount = deployer.getDeployedAddressWithArgs("TownsAccount");
        console.log("  TownsAccount:", townsAccount);

        // =========================================================
        // PHASE 3: AccountProxy (LibEIP7702, not CREATE2)
        // =========================================================
        console.log("\nPhase 3: Deploying AccountProxy...");
        vm.startBroadcast(deployerAddr);
        accountProxy = LibEIP7702.deployProxy(townsAccount, address(0));
        vm.stopBroadcast();
        console.log("  AccountProxy:", accountProxy);

        // =========================================================
        // PHASE 4: Config-driven contracts
        // =========================================================
        console.log("\nPhase 4: Deploying config-driven contracts...");

        // SimpleFunder
        address funderAddr = _getEnvAddressOrDefault("FUNDER", deployerAddr);
        address funderOwner = _getEnvAddressOrDefault("DEPLOYER_ADDRESS", deployerAddr);
        deployer.addWithArgs("SimpleFunder", abi.encode(funderAddr, funderOwner));

        // SimpleSettler
        address settlerOwner = _getEnvAddressOrDefault("DEPLOYER_ADDRESS", deployerAddr);
        deployer.addWithArgs("SimpleSettler", abi.encode(settlerOwner));

        // LayerZeroSettler (optional - only if endpoint is configured)
        address lzEndpoint = vm.envOr("LZ_ENDPOINT", address(0));
        if (lzEndpoint != address(0)) {
            address lzOwner = _getEnvAddressOrDefault("DEPLOYER_ADDRESS", deployerAddr);
            address lzSigner = vm.envAddress("LZ_SETTLER_SIGNER");
            deployer.addWithArgs("LayerZeroSettler", abi.encode(lzEndpoint, lzOwner, lzSigner));
        }

        deployer.deployArgsQueue(deployerAddr);

        console.log("  SimpleFunder:", deployer.getDeployedAddressWithArgs("SimpleFunder"));
        console.log("  SimpleSettler:", deployer.getDeployedAddressWithArgs("SimpleSettler"));

        address lzSettler = deployer.getDeployedAddressWithArgs("LayerZeroSettler");
        if (lzSettler != address(0)) {
            console.log("  LayerZeroSettler:", lzSettler);
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
            "townsAccount",
            deployer.getDeployedAddressWithArgs("TownsAccount")
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
            _writeContractDeployment(chainId, _toLowerFirst(name), deployed);
            console.log("  Deployed at:", deployed);
        }
        // TownsAccount - needs Orchestrator
        else if (name.eq("TownsAccount")) {
            address orchestrator = _getExistingOrDeploy(chainId, "Orchestrator", deployerAddr);
            deployer.addWithArgs("TownsAccount", abi.encode(orchestrator));
            deployer.deployArgsQueue(deployerAddr);
            address deployed = deployer.getDeployedAddressWithArgs("TownsAccount");
            _writeContractDeployment(chainId, "townsAccount", deployed);
            console.log("  Deployed at:", deployed);
        }
        // AccountProxy - needs TownsAccount
        else if (name.eq("AccountProxy")) {
            address townsAccount = _getExistingOrDeploy(chainId, "TownsAccount", deployerAddr);
            vm.startBroadcast(deployerAddr);
            address proxy = LibEIP7702.deployProxy(townsAccount, address(0));
            vm.stopBroadcast();
            _writeContractDeployment(chainId, "accountProxy", proxy);
            console.log("  Deployed at:", proxy);
        }
        // SimpleFunder - uses env vars
        else if (name.eq("SimpleFunder")) {
            address funder = _getEnvAddressOrDefault("FUNDER", deployerAddr);
            address owner = _getEnvAddressOrDefault("DEPLOYER_ADDRESS", deployerAddr);
            deployer.addWithArgs("SimpleFunder", abi.encode(funder, owner));
            deployer.deployArgsQueue(deployerAddr);
            address deployed = deployer.getDeployedAddressWithArgs("SimpleFunder");
            _writeContractDeployment(chainId, "simpleFunder", deployed);
            console.log("  Deployed at:", deployed);
        }
        // SimpleSettler - uses env vars
        else if (name.eq("SimpleSettler")) {
            address owner = _getEnvAddressOrDefault("DEPLOYER_ADDRESS", deployerAddr);
            deployer.addWithArgs("SimpleSettler", abi.encode(owner));
            deployer.deployArgsQueue(deployerAddr);
            address deployed = deployer.getDeployedAddressWithArgs("SimpleSettler");
            _writeContractDeployment(chainId, "simpleSettler", deployed);
            console.log("  Deployed at:", deployed);
        }
        // LayerZeroSettler - uses env vars
        else if (name.eq("LayerZeroSettler")) {
            address endpoint = vm.envOr("LZ_ENDPOINT", address(0));
            require(endpoint != address(0), "LZ_ENDPOINT not set");
            address owner = _getEnvAddressOrDefault("DEPLOYER_ADDRESS", deployerAddr);
            address signer = vm.envAddress("LZ_SETTLER_SIGNER");
            deployer.addWithArgs("LayerZeroSettler", abi.encode(endpoint, owner, signer));
            deployer.deployArgsQueue(deployerAddr);
            address deployed = deployer.getDeployedAddressWithArgs("LayerZeroSettler");
            _writeContractDeployment(chainId, "layerZeroSettler", deployed);
            console.log("  Deployed at:", deployed);
        } else {
            revert(string.concat("Unknown contract: ", name));
        }
    }

    /// @notice Get existing deployed address or deploy the contract
    function _getExistingOrDeploy(
        uint256 chainId,
        string memory name,
        address deployerAddr
    ) internal returns (address) {
        // Check if already deployed via CREATE2 prediction
        address existing = deployer.getDeployedAddress(name);
        if (existing != address(0)) {
            console.log("  Found existing (CREATE2):", name, existing);
            return existing;
        }

        // Check deployment file
        existing = _tryReadDeploymentAddress(chainId, _toLowerFirst(name));
        if (existing != address(0)) {
            console.log("  Found existing (file):", name, existing);
            // Cache it in the deployer for future lookups
            deployer.cacheDeployedAddress(name, existing);
            return existing;
        }

        // Deploy it
        console.log("  Deploying dependency:", name);
        _deployContract(chainId, name, deployerAddr);

        // For no-arg contracts, get from deployer
        address deployed = deployer.getDeployedAddress(name);
        if (deployed != address(0)) return deployed;

        // For with-arg contracts
        return deployer.getDeployedAddressWithArgs(name);
    }

    /// @notice Try to read deployment address, returns address(0) if file doesn't exist
    function _tryReadDeploymentAddress(
        uint256 chainId,
        string memory contractName
    ) internal view returns (address) {
        string memory dirPath = _getDeploymentDir(chainId);
        string memory path = string.concat(dirPath, "/", contractName, ".json");

        // Check if file exists
        if (!vm.exists(path)) return address(0);

        string memory json = vm.readFile(path);
        return vm.parseJsonAddress(json, ".address");
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
    function _toLowerFirst(string memory str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        if (b.length == 0) return str;

        // Only convert if first char is uppercase A-Z
        if (b[0] >= 0x41 && b[0] <= 0x5A) {
            b[0] = bytes1(uint8(b[0]) + 32);
        }
        return string(b);
    }
}
