# Agentic Payments Contracts

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
| **Account** | EIP-7702 account with key management |
| **Orchestrator** | Intent verification, gas compensation, execution |
| **GuardedExecutor** | Execution guards and spend limits |
| **Escrow** | Token escrow with cross-chain settlement |
| **SimpleFunder** | Relayer funding mechanism |
| **LayerZeroSettler** | Cross-chain settlement via LayerZero v2 |
| **Simulator** | Gas simulation for orchestrator calls |

## Deployment

From `packages/contracts`. There is no Makefile. `./scripts/sh/deploy.sh` chooses the chain and RPC.

| Command | Chain | Context | RPC |
| --- | --- | --- | --- |
| `./scripts/sh/deploy.sh local` | 31337 and 41337 | `local` | `http://localhost:8545` and `http://localhost:8546` |
| `./scripts/sh/deploy.sh dev` | Base Sepolia 84532 | `dev` | `RPC_84532`, or `https://sepolia.base.org` if unset |
| `./scripts/sh/deploy.sh stage` | Base 8453 | `stage` | `RPC_8453`, or `https://mainnet.base.org` if unset |
| `./scripts/sh/deploy.sh prod` | Base 8453 | `prod` | `RPC_8453`, or `https://mainnet.base.org` if unset |

`dev`, `stage`, and `prod` need one of `--account`, `--ledger`, `--private-key`, or `--sender`. Local uses the Anvil deployer key. The same script is `bun run deploy:local`, `deploy:dev`, `deploy:stage`, and `deploy:prod`.

`--rpc` overrides the URL for every chain in that run. `--chain` overrides the shortcut's chain ids. `--context` overrides the deployment context. `--contracts` limits which contracts deploy. Other flags the script accepts: `--verify`, `--dry-run`, `--resume`, `--skip-relayer`, `--funder`, `--owner`, `--relayer-mnemonic`, `--relayer-count`. Run `./scripts/sh/deploy.sh --help` for the full list.

```bash
./scripts/sh/deploy.sh local
./scripts/sh/deploy.sh dev --account deployer
RPC_8453=https://mainnet.base.org ./scripts/sh/deploy.sh prod --account deployer
./scripts/sh/deploy.sh dev --contracts SimpleFunder,SimpleSettler --account deployer
```

Then generate TypeScript ABIs:

```bash
bun run build
```

Artifacts:

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
