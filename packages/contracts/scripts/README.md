# Deployment Scripts

This directory contains the deployment scripts for the Account system.

## Quick Start

```bash
# Start local anvil (in separate terminal)
anvil

# Deploy all contracts to local anvil
./scripts/sh/deploy.sh local

# Deploy to dev (Base Sepolia) with keystore account
./scripts/sh/deploy.sh dev --account deployer

# Deploy specific contracts
./scripts/sh/deploy.sh local --contracts SimpleFunder,SimpleSettler
```

## Scripts Overview

| Script | Purpose |
|--------|---------|
| `deploy.sh` | **Main deployment script** - Handles all environments and contract selection |
| `DeployUnified.s.sol` | Forge script invoked by deploy.sh |
| `Deploy.s.sol` | Legacy simple deployment for local dev |
| `DeployAll.s.sol` | Alternative approach (reference) |

## deploy.sh

The bash deployment script is a powerful, chain-agnostic deployment tool supporting:
- **Multi-chain deployment** - Deploy to any EVM chain, multiple chains at once
- **Full or selective deployment** - Deploy all contracts or specific ones
- **Resume failed deployments** - Skip already-deployed contracts
- **Dry run mode** - Simulate without broadcasting
- **Built-in chain support** - Optimism, Arbitrum, Polygon, Base (Sepolia/Mainnet), Anvil
- **CREATE2 deterministic addresses** - Same address across chains
- **Relayer setup automation** - Whitelist and fund relayers
- **Flexible authentication** - Keystore, Ledger, or private key
- **Custom gas settings** - For congested networks

### Usage

```
Usage: ./scripts/sh/deploy.sh [environment] [options]

Environments (shortcuts):
  local          Deploy to local Anvil (chain 31337)
  dev            Deploy to Base Sepolia (chain 84532)
  stage          Deploy to Base Mainnet (chain 8453)
  prod           Deploy to Base Mainnet (chain 8453)

Or specify chain directly:
  --chain <id>   Chain ID(s) to deploy to (comma-separated for multiple)

Options:
  --rpc <url>              RPC URL (required if chain not recognized)
  --contracts <list>       Comma-separated contracts to deploy (default: all)
  --context <name>         Deployment context for output dir (default: derived from chain)

Authentication (one required for non-local):
  --account <name>         Use keystore account
  --password <pass>        Password for keystore account
  --password-file <path>   File containing keystore password
  --ledger <path>          Use Ledger with HD path
  --private-key <key>      Use private key directly

Contract Configuration:
  --funder <addr>          SimpleFunder funder address
  --owner <addr>           Owner address for contracts (SimpleFunder, SimpleSettler, etc.)
  --relayer-mnemonic <m>   Mnemonic for relayer signers
  --relayer-count <n>      Number of relayer signers (default: 10)
  --skip-relayer           Skip relayer setup phase

LayerZero (optional):
  --lz-endpoint <addr>     LayerZero endpoint address
  --lz-signer <addr>       LayerZero settler signer

Gas Settings:
  --gas-price <gwei>       Gas price in gwei
  --priority-fee <gwei>    Priority fee in gwei (EIP-1559)

Verification:
  --verify                 Verify contracts on block explorer
  --etherscan-key <key>    Etherscan API key (overrides env)

Other:
  --dry-run                Simulate without broadcasting
  --resume                 Skip contracts that are already deployed
  --help                   Show this help message
```

### Quick Examples

```bash
# Local anvil
./scripts/sh/deploy.sh local

# Base Sepolia (dev) with keystore
./scripts/sh/deploy.sh dev --account deployer

# Base Mainnet (stage) with Ledger and verification
./scripts/sh/deploy.sh stage --ledger "m/44'/60'/0'/0/0" --verify

# Deploy to Optimism
./scripts/sh/deploy.sh --chain 10 --account deployer

# Deploy to multiple chains at once
./scripts/sh/deploy.sh --chain 10,42161 --account deployer

# Selective deployment
./scripts/sh/deploy.sh dev --contracts SimpleFunder,SimpleSettler --account deployer

# Deploy without relayer setup
./scripts/sh/deploy.sh dev --skip-relayer --account deployer

# Dry run to test deployment
./scripts/sh/deploy.sh prod --dry-run --account deployer

# Resume a failed deployment
./scripts/sh/deploy.sh prod --resume --account deployer

# Deploy with custom gas settings on congested network
./scripts/sh/deploy.sh --chain 137 --gas-price 100 --priority-fee 30 --account deployer

# Deploy with custom funder/owner addresses
./scripts/sh/deploy.sh --chain 8453 --funder 0x123... --owner 0x456... --account deployer
```

### Chain-Agnostic Deployment

Deploy to any EVM chain using `--chain`:

```bash
# Optimism Mainnet (chain 10)
./scripts/sh/deploy.sh --chain 10 --account deployer

# Arbitrum One (chain 42161)
./scripts/sh/deploy.sh --chain 42161 --account deployer

# Polygon (chain 137)
./scripts/sh/deploy.sh --chain 137 --account deployer

# Custom chain with explicit RPC
./scripts/sh/deploy.sh --chain 999 --rpc https://rpc.example.com --account deployer
```

**Built-in RPC defaults:**
- Optimism (10): `https://mainnet.optimism.io`
- Arbitrum One (42161): `https://arb1.arbitrum.io/rpc`
- Polygon (137): `https://polygon-rpc.com`
- Base Sepolia (84532): `https://sepolia.base.org`
- Base Mainnet (8453): `https://mainnet.base.org`
- Anvil (31337): `http://127.0.0.1:8545`

### Multi-Chain Deployment

Deploy to multiple chains in a single command:

```bash
# Deploy Orchestrator to Optimism and Arbitrum
./scripts/sh/deploy.sh --chain 10,42161 --contracts Orchestrator --account deployer

# Deploy full system to multiple L2s
./scripts/sh/deploy.sh --chain 10,42161,137 --account deployer --verify
```

### Selective Deployment

Deploy specific contracts only:

```bash
# Single contract
./scripts/sh/deploy.sh local --contracts Orchestrator

# Multiple contracts
./scripts/sh/deploy.sh dev --contracts SimpleFunder,SimpleSettler --account deployer

# Contract with dependencies (Orchestrator auto-deployed if missing)
./scripts/sh/deploy.sh local --contracts Account

# Deploy SimpleSettler to Optimism
./scripts/sh/deploy.sh --chain 10 --contracts SimpleSettler --account deployer
```

**Supported contract names:**
- `Orchestrator` - No dependencies
- `Simulator` - No dependencies
- `Escrow` - No dependencies
- `Account` - Requires Orchestrator
- `AccountProxy` - Requires Account
- `SimpleFunder` - Requires funder, owner
- `SimpleSettler` - Requires owner
- `LayerZeroSettler` - Requires endpoint, owner, signer

### Resume Failed Deployments

If a deployment fails partway through, resume from where it left off:

```bash
# Resume prod deployment
./scripts/sh/deploy.sh prod --resume --account deployer

# Resume with same options as original deployment
./scripts/sh/deploy.sh --chain 10 --resume --account deployer
```

The `--resume` flag skips contracts that are already deployed at their predicted CREATE2 addresses.

### Gas Configuration

On congested networks, specify gas settings:

```bash
# High gas price for fast confirmation
./scripts/sh/deploy.sh --chain 137 --gas-price 150 --account deployer

# EIP-1559 with priority fee
./scripts/sh/deploy.sh prod --gas-price 50 --priority-fee 2 --account deployer --verify
```

### Custom Addresses

Override default funder/owner addresses:

```bash
# Custom funder for SimpleFunder
./scripts/sh/deploy.sh stage --funder 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb --account deployer

# Custom owner for all contracts
./scripts/sh/deploy.sh prod --owner 0x123... --account deployer

# Both custom addresses
./scripts/sh/deploy.sh --chain 10 --funder 0x123... --owner 0x456... --account deployer
```

### Skip Relayer Setup

Deploy contracts without setting up relayers:

```bash
# Deploy without relayer configuration
./scripts/sh/deploy.sh dev --skip-relayer --account deployer

# Useful when relayers will be configured later or manually
./scripts/sh/deploy.sh prod --skip-relayer --contracts SimpleFunder --account deployer
```

## Deployment Phases

Full deployment runs in 6 phases:

1. **No-arg contracts** - Orchestrator, Simulator, Escrow (batched via CREATE2)
2. **Account** - Depends on Orchestrator address
3. **AccountProxy** - Uses LibEIP7702 (not CREATE2)
4. **Config-driven** - SimpleFunder, SimpleSettler, LayerZeroSettler
5. **Relayer setup** - Whitelist signers, fund on local
6. **Save deployments** - Write JSON files to `deployments/envs/`

## Configuration

Configuration can be provided via:
1. **Command-line flags** (highest priority)
2. **Environment variables** (fallback)

### Environment Variables

Copy `.env.example` to `.env` and set your values. Command-line flags override these.

#### Local Environment

```bash
# Anvil private key (default provided)
LOCAL_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Test mnemonic for relayer signers (default provided)
RELAYER_MNEMONIC=test test test test test test test test test test test junk

# Number of relayer signers to derive
RELAYER_COUNT=10
```

#### Dev Environment (Base Sepolia)

```bash
# Relayer mnemonic for dev
DEV_RELAYER_MNEMONIC=your dev mnemonic here

# SimpleFunder funder address
DEV_FUNDER=0x...

# Deployer/owner address for contracts
DEV_DEPLOYER_ADDRESS=0x...

# RPC URL (optional, has default)
RPC_84532=https://sepolia.base.org
```

#### Stage Environment (Base Mainnet)

```bash
# Relayer mnemonic for stage
STAGE_RELAYER_MNEMONIC=your stage mnemonic here

# SimpleFunder funder address
STAGE_FUNDER=0x...

# Deployer/owner address for contracts
STAGE_DEPLOYER_ADDRESS=0x...

# RPC URL (optional, has default)
RPC_8453=https://mainnet.base.org
```

#### Prod Environment (Base Mainnet)

```bash
# Relayer mnemonic for production
PROD_RELAYER_MNEMONIC=your prod mnemonic here

# SimpleFunder funder address
PROD_FUNDER=0x...

# Deployer/owner address for contracts
PROD_DEPLOYER_ADDRESS=0x...

# RPC URL (optional, has default)
RPC_8453=https://mainnet.base.org
```

#### Custom Chains

For chains not listed above, set RPC via environment variable:

```bash
# Pattern: RPC_{CHAIN_ID}
RPC_10=https://mainnet.optimism.io
RPC_42161=https://arb1.arbitrum.io/rpc
RPC_137=https://polygon-rpc.com
```

Or use `--rpc` flag at runtime.

#### LayerZero (Optional)

```bash
# LayerZero endpoint address for LayerZeroSettler
LZ_ENDPOINT=0x...

# Authorized signer for LayerZeroSettler
LZ_SETTLER_SIGNER=0x...
```

#### Verification

```bash
# Block explorer API key for contract verification
ETHERSCAN_API_KEY=your_api_key_here
```

### Command-Line Overrides

All configuration can be overridden via flags:

```bash
# Override funder address
./scripts/sh/deploy.sh dev --funder 0x123... --account deployer

# Override owner address
./scripts/sh/deploy.sh prod --owner 0x456... --account deployer

# Override relayer config
./scripts/sh/deploy.sh --chain 10 --relayer-mnemonic "your mnemonic" --relayer-count 5 --account deployer

# Override RPC URL
./scripts/sh/deploy.sh --chain 999 --rpc https://custom-rpc.com --account deployer

# Override Etherscan key
./scripts/sh/deploy.sh prod --verify --etherscan-key YOUR_KEY --account deployer
```

### Priority Order

Configuration values are resolved in this order (highest to lowest):
1. Command-line flags (`--funder`, `--owner`, etc.)
2. Environment-specific variables (`STAGE_FUNDER`, `PROD_FUNDER`)
3. Generic environment variables (`RELAYER_MNEMONIC`, `RELAYER_COUNT`)
4. Built-in defaults (for Anvil local deployment)

## Output Structure

Deployments are saved to:
```
deployments/envs/{context}/{chainId}/{contractName}.json
```

### Context Resolution

The deployment context (directory name) is determined by:
1. `--context` flag (if provided)
2. Environment shortcut (`local`, `dev`, `stage`, `prod`)
3. Chain ID mapping:
   - 31337 → `local`
   - 84532 → `dev`
   - 8453 → `prod`
   - Others → `chain_{chainId}`

Examples:
```
# Environment shortcuts
./scripts/sh/deploy.sh local
→ deployments/envs/local/31337/orchestrator.json

./scripts/sh/deploy.sh dev --account deployer
→ deployments/envs/dev/84532/simpleFunder.json

# Chain ID (auto-context)
./scripts/sh/deploy.sh --chain 10 --account deployer
→ deployments/envs/chain_10/10/orchestrator.json

# Custom context
./scripts/sh/deploy.sh --chain 10 --context optimism --account deployer
→ deployments/envs/optimism/10/orchestrator.json

# Multi-chain deployment
./scripts/sh/deploy.sh --chain 10,42161 --context l2 --account deployer
→ deployments/envs/l2/10/orchestrator.json
→ deployments/envs/l2/42161/orchestrator.json
```

### File Format

Each deployment file contains:
```json
{
  "address": "0x..."
}
```

## Contract Dependencies

```
No Dependencies (batched):
  Orchestrator ─┬─► Account ──► AccountProxy
  Simulator    │
  Escrow       │

Config-Driven:
  SimpleFunder     (funder, owner)
  SimpleSettler    (owner)
  LayerZeroSettler (endpoint, owner, signer)
```

## CREATE2 Determinism

All contracts (except AccountProxy) use CREATE2 via `DeployFacetWithArgs`:
- Same bytecode + salt = same address across chains
- Already-deployed contracts are automatically skipped
- Use `deployer.getDeployedAddress(name)` to get predicted/deployed address

## Local Setup

The script automatically handles local environment setup:
1. Deploys Multicall3 if not present
2. Deploys MockUSDC for testing
3. Runs standard deployment flow
4. Funds SimpleFunder with 10 ETH

## Relayer Setup

When relayer mnemonic is configured:
1. Derives `RELAYER_COUNT` signer addresses from mnemonic
2. Whitelists signers as gas wallets on SimpleFunder
3. Whitelists Orchestrator on SimpleFunder
4. Funds SimpleFunder (local anvil only)

## Helper Scripts

### DeployFacetWithArgs.sol

Extends `DeployFacet` from `@towns-protocol/diamond`:
- `add(name)` - Queue no-arg contract
- `addWithArgs(name, args)` - Queue contract with constructor args
- `deployBatch(deployer)` - Deploy no-arg queue via Multicall3
- `deployArgsQueue(deployer)` - Deploy with-args queue

### DeployHelper.s.sol

Common utilities:
- `_writeContractDeployment(chainId, name, addr)` - Save to JSON
- `_getDeploymentDir(chainId)` - Get output directory path

## Troubleshooting

### "Missing required environment variable"
Ensure your `.env` file is properly configured for the target environment, or provide values via command-line flags.

For dev:
- `DEV_RELAYER_MNEMONIC` or `--relayer-mnemonic`
- `DEV_FUNDER` or `--funder`
- `DEV_DEPLOYER_ADDRESS` or `--owner`

For stage:
- `STAGE_RELAYER_MNEMONIC` or `--relayer-mnemonic`
- `STAGE_FUNDER` or `--funder`
- `STAGE_DEPLOYER_ADDRESS` or `--owner`

For prod:
- `PROD_RELAYER_MNEMONIC` or `--relayer-mnemonic`
- `PROD_FUNDER` or `--funder`
- `PROD_DEPLOYER_ADDRESS` or `--owner`

Alternatively, skip relayer setup:
```bash
./scripts/sh/deploy.sh dev --skip-relayer --account deployer
```

### "RPC URL not found for chain"
For custom chains, provide RPC URL via:
```bash
# Environment variable
export RPC_999=https://custom-rpc.com
./scripts/sh/deploy.sh --chain 999 --account deployer

# Or command-line flag
./scripts/sh/deploy.sh --chain 999 --rpc https://custom-rpc.com --account deployer
```

### Contract already deployed
CREATE2 ensures idempotency - if a contract exists at its predicted address, it's skipped automatically. This is expected behavior and not an error.

To redeploy anyway, manually remove the deployment JSON file:
```bash
rm deployments/envs/dev/84532/orchestrator.json
./scripts/sh/deploy.sh dev --contracts Orchestrator --account deployer
```

### Deployment failed partway through
Use `--resume` to skip already-deployed contracts:
```bash
./scripts/sh/deploy.sh prod --resume --account deployer
```

This is especially useful after network issues or gas price spikes.

### Gas price too low
On congested networks, specify higher gas settings:
```bash
# Legacy gas pricing
./scripts/sh/deploy.sh --chain 137 --gas-price 150 --account deployer

# EIP-1559 pricing
./scripts/sh/deploy.sh prod --gas-price 50 --priority-fee 2 --account deployer
```

### Verification fails
Ensure `ETHERSCAN_API_KEY` is set and the chain is supported by Etherscan/Basescan:
```bash
export ETHERSCAN_API_KEY="your_api_key"
./scripts/sh/deploy.sh dev --verify --account deployer

# Or override via flag
./scripts/sh/deploy.sh dev --verify --etherscan-key YOUR_KEY --account deployer
```

Supported chains for verification:
- Base Sepolia (84532): Basescan
- Base Mainnet (8453): Basescan
- Optimism (10): Optimistic Etherscan
- Arbitrum One (42161): Arbiscan
- Polygon (137): Polygonscan

### "Anvil not running"
For local deployment, start anvil in a separate terminal:
```bash
anvil
```

### Keystore/Ledger issues
For stage, ensure you've created a keystore account:
```bash
cast wallet import deployer --interactive
```

For prod with Ledger:
- Ensure it's connected and unlocked
- Ethereum app must be open
- Contract data must be enabled in settings

### Dry run for testing
Test deployment without broadcasting transactions:
```bash
# Test dev deployment
./scripts/sh/deploy.sh dev --dry-run --account deployer

# Test multi-chain deployment
./scripts/sh/deploy.sh --chain 10,42161 --dry-run --account deployer
```

### Multi-chain deployment partially failed
When deploying to multiple chains, if one fails:
1. Check which chains succeeded (look at `deployments/envs/` directory)
2. Redeploy to failed chains only:
```bash
# Original: --chain 10,42161,137
# Chain 137 failed, so:
./scripts/sh/deploy.sh --chain 137 --account deployer
```

Or use `--resume` to automatically skip succeeded chains:
```bash
./scripts/sh/deploy.sh --chain 10,42161,137 --resume --account deployer
```
