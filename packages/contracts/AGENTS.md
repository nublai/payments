# AGENTS.md

This file provides guidance to ai agents when working with code in this repository.

## Quickstart (Local Dev)

```bash
bun install
cp .env.example .env
bun run dev
```

## Commands

```bash
# Build & generate TypeScript ABIs
bun run build

# Run all tests
bun run test

# Run single test
forge test --match-test testFunctionName

# Run tests for single contract
forge test --match-contract ContractName

# Test with gas report
bun run test:gas

# Format code (Prettier)
bun run fmt

# Lint check (Prettier check)
bun run lint

# Local development (starts Anvil + deploys + generates config)
bun run dev
```

## Local Dev & Deployment Notes

- `bun run dev` runs `scripts/sh/dev.sh` (starts Anvil on 8545, then `bun run deploy:local`).
- Main deploy script is `scripts/sh/deploy.sh`; see `scripts/README.md` for all flags and examples.
- `deploy:local` runs deploy + `deployments/make-config.js` to generate config JSON.
- Build uses `wagmi.config.ts` to generate TS ABIs (`wagmi generate`).

## Deployment

```bash
# Local Anvil
./scripts/sh/deploy.sh local

# Base Sepolia (dev) - requires --account or env vars
./scripts/sh/deploy.sh dev --account deployer

# Base Mainnet (stage) - requires --ledger or --account
./scripts/sh/deploy.sh stage --ledger "m/44'/60'/0'/0/0" --verify

# Base Mainnet (prod) - requires --ledger or --account
./scripts/sh/deploy.sh prod --ledger "m/44'/60'/0'/0/0" --verify

# Selective deployment
./scripts/sh/deploy.sh dev --contracts SimpleFunder,SimpleSettler

# Dry run (no broadcast)
./scripts/sh/deploy.sh local --dry-run
```

Configuration via environment variables (see `.env.example`). Artifacts saved to `deployments/envs/{context}/{chainId}/`.

## Architecture

This is an EIP-7702 account abstraction system with intent-based execution.

### Core Flow

1. **TownsAccount** (`src/accounts/TownsAccount.sol`) - EIP-7702 delegated account that EOAs point to. Manages keys (Secp256k1/External), handles 2D nonces (192-bit seqKey + 64-bit sequential), validates EIP-712 signatures.

2. **Orchestrator** (`src/accounts/Orchestrator.sol`) - Central execution coordinator. Verifies signed `Intent` structs, executes calls atomically, compensates relayers for gas, handles cross-chain fund transfers via settlers.

3. **GuardedExecutor** (`src/accounts/GuardedExecutor.sol`) - Enforces per-token spend limits (rolling windows: Minute/Hour/Day/Week/Month/Year/Forever) and whitelist-based execution guards on calldata.

4. **Escrow** (`src/accounts/Escrow.sol`) - Holds tokens for cross-chain settlement with refund mechanisms.

5. **SimpleFunder** (`src/accounts/SimpleFunder.sol`) - Authorizes relayer gas withdrawals via EIP-712 signatures.

6. **LayerZeroSettler** (`src/accounts/LayerZeroSettler.sol`) - Cross-chain settlement using LayerZero v2 OApp.

### Key Structures

The `Intent` struct (defined in `src/accounts/interfaces/ICommon.sol`) contains ~22 fields including EOA, execution data, nonce, payment info, and precalls. Relayers submit signed intents to the Orchestrator.

### Nonce System

Uses ERC-4337 style 2D nonces (`LibNonce.sol`):
- Upper 192 bits: sequence key (with multichain prefix for cross-chain)
- Lower 64 bits: sequential nonce within that sequence

### Test Setup

Tests extend `test/Base.t.sol` which sets up mock orchestrator, accounts, and payment tokens. LayerZero tests use mocks in `test/mocks/`.

## Relayer-Contracts Gotchas

- **TownsAccount bytecode limit**: must stay under 24KB; optimizer runs are tuned for this (`foundry.toml`).
- **Release profile differs**: deployments should use `forge build --profile release` (via IR, 200 runs).
- **CREATE2 determinism**: most contracts use CREATE2; redeploys are skipped if address is already used.
- **Local deploy preloads code**: `deploy.sh local` writes Multicall3 + MockUSDC bytecode via `anvil_setCode`.
- **Relayer setup is optional**: `--skip-relayer` avoids mnemonic-derived signer setup (useful for partial deploys).

## Constraints

- Transient storage used for reentrancy protection
- CREATE2 deployment ensures deterministic addresses across chains
