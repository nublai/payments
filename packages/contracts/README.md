# Towns Protocol Contracts

Solidity smart contracts for EIP-7702 account abstraction, intent-based execution, and cross-chain settlement.

## Quick Start

```bash
# Install dependencies
bun install

# Copy environment variables
cp .env.example .env

# Start local development (Anvil + deploy + generate config)
bun run dev
```

## Scripts

```bash
bun run dev              # Start Anvil, deploy contracts, generate config
bun run build            # Compile contracts and generate TypeScript ABIs
bun run generate         # Generate TypeScript ABIs only
bun run test             # Run tests with verbose output
bun run test:gas         # Run tests with gas report
bun run coverage         # Generate coverage report
bun run fmt              # Format with Prettier
bun run lint             # Check Prettier formatting
bun run deploy:local     # Deploy to local Anvil (for CI)
bun run deploy:dev       # Deploy to Base Sepolia
bun run deploy:stage     # Deploy to Base Mainnet (stage context)
bun run deploy:prod      # Deploy to Base Mainnet (prod context)
bun run make-config      # Generate deployment config
```

## Configuration

### Environment Variables

Set in `.env` (copy from `.env.example`):

| Name | Description |
|------|-------------|
| `ANVIL_RPC_URL` | Local Anvil endpoint |
| `LOCAL_PRIVATE_KEY` | Deployment key (first Anvil account) |
| `RPC_84532` | Base Sepolia RPC (for bytecode copying) |
| `RELAYER_MNEMONIC` | Mnemonic for relayer signer generation |
| `RELAYER_COUNT` | Number of relayer signers |

### Deployment Config

Chain-specific settings live in `deployments/config.toml`:

| Context | Chain | Description |
|---------|-------|-------------|
| `local` | anvil (31337) | Local Anvil development |
| `dev` | base-sepolia (84532) | Base Sepolia testnet |
| `stage` | base (8453) | Base Mainnet |
| `prod` | base (8453) | Base Mainnet |

Each chain section includes:
- RPC endpoint URL
- Constructor arguments for contracts
- Relayer mnemonic and count

## Architecture

| Contract | Purpose |
|----------|---------|
| **TownsAccount** | EIP-7702 account with key management |
| **Orchestrator** | Intent verification, gas compensation, execution |
| **GuardedExecutor** | Execution guards and spend limits |
| **Escrow** | Token escrow with cross-chain settlement |
| **SimpleFunder** | Relayer funding mechanism |
| **LayerZeroSettler** | Cross-chain settlement via LayerZero v2 |
| **Simulator** | Gas simulation for orchestrator calls |

## Deployment

### First-time Setup

1. Configure environment:
```bash
cp .env.example .env
# Edit .env with your RPC URLs and private keys
```

2. Configure deployment in `deployments/config.toml`:
   - Set constructor arguments per chain
   - Configure relayer mnemonic and count

3. Deploy:
```bash
# Local development
make deploy-local-unified

# Dev (Base Sepolia)
make deploy-dev-unified

# Production (Base Mainnet)
make deploy-unified CHAINS=8453 CONTEXT=prod
```

4. Generate TypeScript ABIs:
```bash
bun run build
```

### Updating Contracts

```bash
make deploy-dev-unified                     # Redeploy to dev
make deploy-unified CHAINS=8453 CONTEXT=prod  # Redeploy to prod
```

### Selective Deployment

Deploy specific contracts only:
```bash
make deploy-unified CHAINS=84532 CONTRACTS=SimpleFunder,SimpleSettler
```

### Deployment Artifacts

- `deployments/envs/<context>/<chainId>/` - Contract addresses
- `broadcast/` - Transaction records
- `deployments/addresses.json` - Address mappings

## Testing

```bash
bun run test                          # All tests
bun run test:gas                      # With gas report
bun run coverage                      # Coverage summary
forge test --match-test testName      # Specific test
forge test --match-contract Contract  # Specific contract
```
