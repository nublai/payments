// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// @towns-protocol/diamond is an upstream package, not this product's name.
import {DeployFacet} from "@towns-protocol/diamond/scripts/common/DeployFacet.s.sol";
import {LibDeploy} from "@towns-protocol/diamond/src/utils/LibDeploy.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @title DeployFacetWithArgs
/// @notice Extends DeployFacet to support contracts with constructor arguments
/// @dev Maintains CREATE2 deterministic deployment while supporting constructor args
contract DeployFacetWithArgs is DeployFacet {
    using LibString for *;

    constructor() {
        _registerLocalChains();
    }

    /// @dev Register local dev chains that aren't in StdChains
    function _registerLocalChains() internal {
        setChain(
            "local_arb",
            ChainData({name: "Local Arbitrum", chainId: 41_337, rpcUrl: "http://localhost:8546"})
        );
    }

    /// @dev Extended deployment entry with constructor args
    struct DeploymentWithArgs {
        string name;
        bytes32 salt;
        bytes args;
        uint256 gasEstimate;
        address predictedAddr;
    }

    /// @dev Queue for contracts with constructor args
    DeploymentWithArgs[] internal argsQueue;

    /// @dev Cache for deployed addresses (name => address)
    mapping(string => address) internal deployedAddresses;

    /// @dev Running gas estimate for args queue
    uint256 public argsQueueGasEstimate;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                   DEPLOYMENT WITH ARGS                      */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @notice Add a contract with constructor args to the queue (default salt = 0)
    /// @param name Name of the contract to deploy
    /// @param args ABI-encoded constructor arguments
    function addWithArgs(string memory name, bytes memory args) public {
        addWithArgs(name, args, bytes32(0));
    }

    /// @notice Add a contract with constructor args and salt to the queue
    /// @param name Name of the contract to deploy
    /// @param args ABI-encoded constructor arguments
    /// @param salt Salt for CREATE2 deployment
    function addWithArgs(string memory name, bytes memory args, bytes32 salt) public {
        // Get bytecode and append args
        string memory artifactPath = getArtifactPath(name);
        bytes memory bytecode = bytes.concat(vm.getCode(artifactPath), args);
        bytes32 initCodeHash = keccak256(bytecode);

        // Predict CREATE2 address
        address predicted = LibClone.predictDeterministicAddress(
            initCodeHash,
            salt,
            CREATE2_FACTORY
        );

        // Skip if already deployed
        if (predicted.code.length > 0) {
            deployedAddresses[name] = predicted;
            return;
        }

        // Estimate gas
        uint256 gas = estimateDeploymentGas(bytecode);
        require(
            BASE_TX_COST + gas <= PER_TRANSACTION_GAS_LIMIT,
            string.concat("DeployFacetWithArgs: contract ", name, " exceeds gas limit")
        );
        argsQueueGasEstimate += gas;

        // Add to queue
        argsQueue.push(DeploymentWithArgs(name, salt, args, gas, predicted));
    }

    /// @notice Deploy all contracts with args in the queue
    /// @param deployer Address to deploy from
    function deployArgsQueue(address deployer) public broadcastWith(deployer) {
        uint256 queueLength = argsQueue.length;
        if (queueLength == 0) return;

        if (!isTesting()) {
            info(
                string.concat(
                    unicode"deploying with args \n\t📜 ",
                    queueLength.toString(),
                    " contracts",
                    unicode"\n\t⚡️ on ",
                    chainIdAlias(),
                    unicode"\n\t📬 from deployer address",
                    unicode"\n\t⛽ estimated gas: ",
                    argsQueueGasEstimate.toString()
                ),
                deployer.toHexStringChecksummed()
            );
        }

        // Deploy each contract
        for (uint256 i; i < queueLength; ++i) {
            DeploymentWithArgs storage entry = argsQueue[i];

            address deployed = LibDeploy.deployCode(
                getArtifactPath(entry.name),
                entry.args,
                entry.salt
            );

            deployedAddresses[entry.name] = deployed;

            if (!isTesting()) {
                info(
                    string.concat(unicode"✅ ", entry.name, " deployed at"),
                    deployed.toHexStringChecksummed()
                );
            }
        }

        // Clear the args queue
        delete argsQueue;
        argsQueueGasEstimate = 0;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          GETTERS                            */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @notice Get the deployed address for a contract by name
    /// @dev Checks both parent DeployFacet cache and our deployedAddresses
    /// @param name Name of the contract
    /// @return The deployed address (address(0) if not deployed)
    function getDeployedAddressWithArgs(string memory name) public returns (address) {
        // Check our cache first
        address cached = deployedAddresses[name];
        if (cached != address(0)) return cached;

        // Fall back to parent's method for no-arg contracts
        return getDeployedAddress(name);
    }

    /// @notice Get the args queue
    /// @return entries Array of deployments with args
    /// @return totalGas Total estimated gas
    function getArgsQueue()
        external
        view
        returns (DeploymentWithArgs[] memory entries, uint256 totalGas)
    {
        return (argsQueue, argsQueueGasEstimate);
    }

    /// @notice Clear both queues
    function clearAllQueues() public {
        clearQueue(); // Parent's no-arg queue
        delete argsQueue;
        argsQueueGasEstimate = 0;
    }

    /// @notice Cache a deployed address manually (for contracts deployed outside this system)
    /// @param name Contract name
    /// @param addr Deployed address
    function cacheDeployedAddress(string memory name, address addr) public {
        deployedAddresses[name] = addr;
    }
}
