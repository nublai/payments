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

1. **Account** (`src/accounts/Account.sol`) - EIP-7702 delegated account that EOAs point to. Manages keys (Secp256k1/External), handles 2D nonces (192-bit seqKey + 64-bit sequential), validates EIP-712 signatures.

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

- **Account bytecode limit**: EIP-170 caps runtime bytecode at 24,576 bytes. `scripts/sh/check-runtime-size.sh` builds with `FOUNDRY_PROFILE=release` and fails if Account, or the other contracts `DeployUnified` deploys, exceed that. It prints the Account size and the headroom under 24,576. `deploy.sh` runs it before any broadcast. The forge CI job runs it after the release-profile `forge test`.
- **Release profile is selected for deploy and CI artifacts**: `deploy.sh` and `check-runtime-size.sh` unset inherited `FOUNDRY_*` and `DAPP_*` variables, then set `FOUNDRY_PROFILE=release` (via IR, 200 runs). `build:contracts`, `generate`, the forge CI job, and both local e2e deploys use that profile. Foundry 1.5 writes those artifacts to `out/` (no profile suffix), which is what `DeployFacet` and the wallet passkey deploy read (`out/Account.sol/Account.json`). The size check requires `compilationTarget` `src/accounts/<Name>.sol` → `<Name>`, `appendCBOR` false, `bytecodeHash` none, optimizer enabled, and `evmVersion` prague. `deploy.sh` quotes forge arguments and refuses bytecode-changing forge flags. Local `bun run test` without `FOUNDRY_PROFILE=release` stays on the default profile (`via_ir` false, 500 runs) and is not a deploy or CI artifact.
- **CREATE2 determinism**: most contracts use CREATE2; a later redeploy is skipped if that predicted address is already used and its runtime matches the release artifact. Nubl contracts have never been deployed. The addresses in `addresses.json` and `envs/*.json` are inherited from the Towns deployment and are not ours. There are no existing nubl accounts to migrate or re-delegate. The first deploy uses the release build. That change must replace every address in `addresses.json` and `envs/*.json` with our release CREATE2 addresses in the same change, and check that each JSON address's on-chain code hash matches the release artifact. That check is `scripts/sh/match-release-runtime.py`: it masks every `immutableReferences` span, including Solady EIP-712 chain id. After a masked match, `scripts/sol/common/ReleaseRuntime.sol` requires `Account.ORCHESTRATOR()` to be the verified release Orchestrator, `LayerZeroSettler.endpoint()` to be `LZ_ENDPOINT` (pinned to the LayerZero V2 endpoint on 8453, 42161, 137, and 84532), and the exact runtime for the expected constructor args. A mismatch fails closed in `DeployUnified` and in the `deploy.sh` post-broadcast check `scripts/sol/VerifyRelease.s.sol`. Non-local JSON addresses are zero until that first deploy, and the wallet and relayer do not fall back to env vars for them. `make-config` regenerates the gitignored `deployments/envs/<context>/.env` and `.env.vite` from the JSON; rerun it after the first deploy. `deploy.sh` refuses `--resume`. Release salt-0 addresses are Escrow `0x13122A1dc74D0adc144c904e963d7d58BBe0E5f9`, MultiSigSigner `0x1DdE1F548A0b0a676D325B2633eA3E5F5E7C52c8`, Orchestrator `0xE6CfdB399efdc88FA11964072AB519c65c044130`, Simulator `0x58915cA306aF01724EC5d9AfE75a1Ce4C8dc4A08`. The inherited Escrow and MultiSigSigner values match this tree's default profile only. Account, SimpleFunder, SimpleSettler, and LayerZeroSettler change for the same constructor arguments.
- **Local deploy preloads code**: `deploy.sh local` writes Multicall3 + MockUSDC bytecode via `anvil_setCode`.
- **Relayer setup is optional**: `--skip-relayer` avoids mnemonic-derived signer setup (useful for partial deploys).

## Constraints

- Transient storage used for reentrancy protection
- CREATE2 deployment ensures deterministic addresses across chains
