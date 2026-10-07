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

## Spend limits

A spend limit protects tokens the account holds directly. That guarantee is for a key whose on-chain `canExecute` is an allowlist of targets that hold no standing rights over the account's assets. Standing rights are an ERC-20 allowance, a Permit2 allowance, an ERC-721 or ERC-1155 operator approval, a vault share allowance or operator role, and a signature-checker approval. `Account.isValidSignature` accepts a non-root key when `msg.sender` is in that key's checker set, so an ERC-1271 permit through the checker can `transferFrom` outside `execute` and the spend limit never runs. The contract meters balances. It does not read those rights. Today the wallet does not refuse a payment session when an allowlisted target already holds a standing right. The root key can revoke those rights. A scan of payment-key targets for those rights, at session creation and again at use, is a planned follow-up.

Wildcard keys (`ANY_TARGET` or `ANY_FN_SEL`) and super-admin keys are outside this guarantee. A super-admin key, and the root key, skip the guard. A wildcard key is still metered for its own balance decrease and for recognized selectors. A target that key can call may already hold a standing right.

`GuardedExecutor` balance-meters only tokens that have a spend period for the key. The periods are the ones configured on that key (`Minute` through `Forever`). There is no hardcoded token list.

These selectors are still priced from calldata, and a non-zero amount with no spend period reverts `NoSpendPermissions`: `transfer`, `transferFrom` out of this account, `approve`, `increaseAllowance`, `increaseApproval`, and Permit2 `approve`. `increaseAllowance` and `increaseApproval` are charged and the allowance is reset to zero after the batch. That reset is the leftover-allowance drain, not a balance probe. Permit2 approvals are locked down the same way.

For a token that does have a period, each call is charged on its own. The charge is the max of the amount recognized from calldata and that call's drop in the account's own balance, so a later call's inflow does not offset an earlier call's decrease. The approval reset and Permit2 lockdown are measured the same way, and any extra debit is added to that sum. `pay` charges `max(paymentAmount, the account's balance decrease)` for a metered token. While that batch is running, a nested `execute` into the account reverts `GuardedReentrancy`. The flag is transient storage (EIP-1153), which this account already uses for the key-hash stack, and it is not a storage slot. A failed, reverted, or short `balanceOf` on a metered token reverts with `SpendBalanceReadFailed`.

The following stay outside the guarantee:

- A donor top-up in the same call as a drop in someone else's balance. The charge is the account's own balance decrease, so a drop in the call target's inventory is not spend.
- A vault `withdraw`, or a forward, through a target that already holds a standing right over assets the account keeps outside its token balance.
- Credit-then-pull through a standing allowance, when the account's ending balance does not fall.
- An in-batch permit signed by the EOA (EIP-2612, DAI `permit`, Permit2 `permit`) and a session `customApprove` or any other approval selector besides `approve`, `increaseAllowance`, and `increaseApproval`. Those selectors are not reset. A later pull is not charged while the token still has no spend period.
- A hostile metered token. `balanceOf` returns 32 bytes of a lie (a constant, or a proxy that pins the pre-transfer balance), or an unrecognized selector debits the account and refills the balance before the call returns.
- A token with no spend period. A non-root key can move it through any call that is not a recognized selector, and the move is not charged. That includes swap output and any other token the account already holds, a spender the root key approved earlier (a proxy with no `balanceOf`, the Escrow `escrow` selector alone on a narrow key, a three-item escrow whose amounts are not a recognized token selector, a puller whose token address sits behind a 32-word pad, a puller that masks the token word down to 160 bits), and a call to token A that pulls token B.

Only configured tokens are metered because of bytecode headroom under the 24,576-byte account limit.

## Deployment

From `packages/contracts`. There is no Makefile. `./scripts/sh/deploy.sh` chooses the chain and RPC.

| Command | Chain | Context | RPC |
| --- | --- | --- | --- |
| `./scripts/sh/deploy.sh local` | 31337 and 41337 | `local` | `http://localhost:8545` and `http://localhost:8546` |
| `./scripts/sh/deploy.sh dev` | Base Sepolia 84532 | `dev` | `RPC_84532`, or `https://sepolia.base.org` if unset |
| `./scripts/sh/deploy.sh stage` | Base 8453 | `stage` | `RPC_8453`, or `https://mainnet.base.org` if unset |
| `./scripts/sh/deploy.sh prod` | Base 8453 | `prod` | `RPC_8453`, or `https://mainnet.base.org` if unset |

`dev`, `stage`, and `prod` need `--account`, `--ledger`, or `--private-key`. `--sender` only adds Forge's `--sender` after one of those is set; it is not enough on its own. Local uses the Anvil deployer key. The same script is `bun run deploy:local`, `deploy:dev`, `deploy:stage`, and `deploy:prod`.

`deploy.sh` and `scripts/sh/check-runtime-size.sh` unset inherited `FOUNDRY_*` and `DAPP_*` variables, then set `FOUNDRY_PROFILE=release` (`via_ir`, 200 optimizer runs). Before any broadcast, `deploy.sh` refuses a symlink under `deployments/` or `deploy/` and runs the size check. The check fails if Account or the other contracts `DeployUnified` deploys have runtime bytecode over 24,576 bytes, or if `compilationTarget`, `appendCBOR`, `bytecodeHash`, `optimizer.enabled`, or `evmVersion` is not the release profile. It also rejects an artifact whose bytecode hash was not rewritten by that build unless the hash matches the release stamp. `deploy.sh` passes `--rpc`, `--private-key`, `--sender`, and `--contracts` as quoted arguments and refuses forge flags that change bytecode (`--optimize`, `--via-ir`, `--evm-version`, `--out`, and similar). `build:contracts` and `generate` run the same check after their release-profile forge build. The forge CI job builds and tests with `FOUNDRY_PROFILE=release` only, then runs the size check, which prints the Account runtime size and the headroom under 24,576 bytes. Local `bun run test` without that profile stays on the default profile and is not what deploy or CI artifacts come from. `bun run deploy:local` and both local e2e jobs call `deploy.sh`, which uses the release profile. That profile's only cheatcode write path is `./deployments`. This Foundry selects the profile with `FOUNDRY_PROFILE` and has no profile CLI flag.

Nubl contracts have never been deployed. The addresses in `addresses.json` and `envs/*.json` are inherited from the Towns deployment and are not ours. There are no existing nubl accounts to migrate or re-delegate. The first deploy uses the release build. That change must replace every address in `addresses.json` and `envs/*.json` with our release CREATE2 addresses in the same change, and check that each JSON address's on-chain code hash matches the release artifact. That check is implemented. `DeployUnified` and `deploy.sh` compare on-chain runtime to the release artifact with `scripts/sh/match-release-runtime.py`, which masks every `immutableReferences` span, including Solady EIP-712 chain id and cached address. A JSON dependency address is used only when that compare matches. Code already at a CREATE2 address that does not match is a revert, because CREATE2 cannot replace it. Non-local entries in `addresses.json` and `envs/*.json` are the zero address until that first deploy, so the wallet and relayer fail closed with `not deployed`.

Release creation bytecode differs from the default profile for every CREATE2 contract. Salt is 0 and the factory is `0x4e59b44847b379578588920cA78FbF26c0B4956C`. No-arg contracts:

| Contract | Inherited Towns address | This tree, default profile | This tree, release profile |
| --- | --- | --- | --- |
| Escrow | `0x05f9597eed844410b7c0746A1C584188d0644730` | same address | `0x13122A1dc74D0adc144c904e963d7d58BBe0E5f9` |
| MultiSigSigner | `0xa3972FEebd6E1f973eD19cC586D79B3F61f892A3` | same address | `0x1DdE1F548A0b0a676D325B2633eA3E5F5E7C52c8` |
| Orchestrator | `0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8` or `0x11050FEC41B66730E91c46Bfd25EBFF3B16F5bcC` | `0x2a87aD816CD97423E731E15206F0a84941B35B23` | `0xE6CfdB399efdc88FA11964072AB519c65c044130` |
| Simulator | `0xDAD7c34d0c41698B227D3C5ee3d6d88A78c63a65` | `0x7abfE2f168Cc82229F00D9Dd529E48b0f2515c72` | `0x58915cA306aF01724EC5d9AfE75a1Ce4C8dc4A08` |

Account, SimpleFunder, SimpleSettler, and LayerZeroSettler take constructor arguments. Their creation bytecode also differs between the two profiles, so the CREATE2 address for the same arguments changes. AccountProxy is deployed with `LibEIP7702`, not this salt-0 CREATE2.

Flags the script accepts: `--chain`, `--rpc`, `--contracts`, `--context`, `--account`, `--password`, `--ledger`, `--private-key`, `--sender`, `--funder`, `--owner`, `--relayer-mnemonic`, `--relayer-count`, `--skip-relayer`, `--lz-endpoint`, `--lz-signer`, `--gas-price`, `--priority-fee`, `--verify`, `--etherscan-key`, `--dry-run`, `--help`. `--resume` is refused: `forge script --resume` rebroadcasts stored initcode and does not compare it to the release artifact. Run `./scripts/sh/deploy.sh --help` for the same list.

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
