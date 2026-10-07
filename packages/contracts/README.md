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
bun run build            # Typecheck with tsc and copy addresses and config into dist
bun run build:contracts  # release-profile forge build, wagmi generate, tsc, and copy addresses and config into dist
bun run generate         # Generate TypeScript ABIs with wagmi
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

There is no `deployments/config.toml`. Committed address snapshots are `deployments/config/deployments.json` (top-level keys `alpha`, `beta`, `gamma`, `delta`, `omega`). That file is the exported config and still uses upstream labels such as `river`, `riverRegistry`, `riverAirdrop`, and `space`; those keys stay. `./scripts/sh/deploy.sh` does not read that file. Chain ids and RPCs come from the script: local Anvil defaults, `RPC_84532` for dev, `RPC_8453` for stage and prod. Relayer mnemonic and funder addresses come from flags or env (`DEV_RELAYER_MNEMONIC`, `STAGE_RELAYER_MNEMONIC`, `PROD_RELAYER_MNEMONIC`, and the matching `*_FUNDER` / `*_DEPLOYER_ADDRESS` vars).

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

`dev`, `stage`, and `prod` need `--account`, `--ledger`, or `--private-key`. `--sender` only adds Forge's `--sender` after one of those is set; it is not enough on its own. Local uses the Anvil deployer key. The same script is `bun run deploy:local`, `deploy:dev`, `deploy:stage`, and `deploy:prod`.

`deploy.sh` and `scripts/sh/check-runtime-size.sh` unset inherited `FOUNDRY_*` and `DAPP_*` variables, then set `FOUNDRY_PROFILE=release` (`via_ir`, 200 optimizer runs). Before any broadcast, `deploy.sh` refuses a symlink under `deployments/` or `deploy/` and runs the size check. The check fails if Account or the other contracts `DeployUnified` deploys have runtime bytecode over 24,576 bytes, or if `compilationTarget`, `appendCBOR`, `bytecodeHash`, `optimizer.enabled`, or `evmVersion` is not the release profile. It also rejects an artifact whose bytecode hash was not rewritten by that build unless the hash matches the release stamp. `deploy.sh` passes `--rpc`, `--private-key`, `--sender`, and `--contracts` as quoted arguments and refuses forge flags that change bytecode (`--optimize`, `--via-ir`, `--evm-version`, `--out`, and similar). `build:contracts` and `generate` run the same check after their release-profile forge build. `bun run test` stays on the default profile. CI runs that default suite and `FOUNDRY_PROFILE=release forge test --ffi`.

Release-profile creation bytecode differs from the default profile for every CREATE2 contract, so a release deploy is a new address. It does not upgrade a contract already sitting at a published address. Salt is 0 and the factory is `0x4e59b44847b379578588920cA78FbF26c0B4956C`. No-arg contracts:

| Contract | Published address | This tree, default profile | This tree, release profile |
| --- | --- | --- | --- |
| Escrow | `0x05f9597eed844410b7c0746A1C584188d0644730` | same as published | `0x13122A1dc74D0adc144c904e963d7d58BBe0E5f9` |
| MultiSigSigner | `0xa3972FEebd6E1f973eD19cC586D79B3F61f892A3` | same as published | `0x1DdE1F548A0b0a676D325B2633eA3E5F5E7C52c8` |
| Orchestrator | `0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8` or `0x11050FEC41B66730E91c46Bfd25EBFF3B16F5bcC` | `0x2a87aD816CD97423E731E15206F0a84941B35B23` | `0xE6CfdB399efdc88FA11964072AB519c65c044130` |
| Simulator | `0xDAD7c34d0c41698B227D3C5ee3d6d88A78c63a65` | `0x7abfE2f168Cc82229F00D9Dd529E48b0f2515c72` | `0x58915cA306aF01724EC5d9AfE75a1Ce4C8dc4A08` |

Account, SimpleFunder, SimpleSettler, and LayerZeroSettler take constructor arguments. Their creation bytecode also differs between the two profiles, so the CREATE2 address for the same arguments changes. AccountProxy is deployed with `LibEIP7702`, not this salt-0 CREATE2. The published default-profile addresses will not match a release deploy.

Flags the script accepts: `--chain`, `--rpc`, `--contracts`, `--context`, `--account`, `--password`, `--ledger`, `--private-key`, `--sender`, `--funder`, `--owner`, `--relayer-mnemonic`, `--relayer-count`, `--skip-relayer`, `--lz-endpoint`, `--lz-signer`, `--gas-price`, `--priority-fee`, `--verify`, `--etherscan-key`, `--dry-run`, `--resume`, `--help`. Run `./scripts/sh/deploy.sh --help` for the same list.

```bash
./scripts/sh/deploy.sh local
./scripts/sh/deploy.sh dev --account deployer
RPC_8453=https://mainnet.base.org ./scripts/sh/deploy.sh prod --account deployer
./scripts/sh/deploy.sh dev --contracts SimpleFunder,SimpleSettler --account deployer
```

Then generate TypeScript ABIs:

```bash
bun run generate
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
