# Relayer

Cloudflare Worker that relays signed intents to the blockchain. Manages a pool of signers derived from an HD wallet mnemonic for high-throughput transaction processing.

## Quick Start

```bash
# Install dependencies
bun install

# Copy environment variables
cp .dev.vars.example .dev.vars

# Start local development
bun run dev
```

## Scripts

```bash
bun run dev              # Local development server
bun run build            # Type check and build
bun run test             # Run tests
bun run deploy --env stage   # Deploy to stage
bun run deploy --env prod    # Deploy to prod
```

## Configuration

### Required Secrets

Set these via `wrangler secret put <NAME> --env <stage|prod>`:

| Name               | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `RPC_URL`          | JSON-RPC endpoint (e.g. `https://base-sepolia.g.alchemy.com/v2/...`) |
| `RELAYER_MNEMONIC` | HD wallet mnemonic for deriving signer keys                          |
| `CHAIN_IDS`        | Comma-separated chain IDs (e.g. `8453,137`)                          |

### Optional: Per-Chain RPC Configuration

For multi-network deployments, configure RPC URLs per chain using the `RPC_<chainId>` pattern:

| Name        | Description                                |
| ----------- | ------------------------------------------ |
| `RPC_84532` | RPC URL for Base Sepolia (chain ID 84532)  |
| `RPC_8453`  | RPC URL for Base Mainnet (chain ID 8453)   |
| `RPC_137`   | RPC URL for Polygon Mainnet (chain ID 137) |

Chain-specific RPCs (`RPC_<chainId>`) take precedence over `RPC_URL` for that chain.

See `src/config/chains.json` for supported chains and their metadata.

### Optional: Pool Configuration

| Name                     | Default | Description                        |
| ------------------------ | ------- | ---------------------------------- |
| `RELAYER_COUNT`          | `1`     | Number of signers (max 100)        |
| `MAX_PENDING_PER_SIGNER` | `16`    | Max pending txs per signer         |
| `MAX_PENDING_TOTAL`      | `1000`  | Max pending txs across all signers |
| `MIN_SIGNER_BALANCE`     | `0.01`  | Min balance in ETH before pause    |
| `TARGET_SIGNER_BALANCE`  | `0.01`  | Target balance after refill (ETH)  |

### Optional: Contract Addresses

Auto-loaded from `@nubl/contracts` for known chains. Override for custom deployments.
Names match `@nubl/contracts` env var keys (no `_ADDRESS` suffix):

| Name            | Description                                                    |
| --------------- | -------------------------------------------------------------- |
| `ORCHESTRATOR`  | Required if chain not in deployments                           |
| `ACCOUNT` | Account contract                                         |
| `ACCOUNT_PROXY` | Account Proxy contract                                         |
| `SIMPLE_FUNDER` | SimpleFunder contract                                          |
| `SIMULATOR`     | Simulator contract                                             |
| `CONTEXT`       | Deployment context: `prod`\|`stage`\|`local` (default: `prod`) |

### Optional: Fee Configuration

| Name                        | Default | Description                       |
| --------------------------- | ------- | --------------------------------- |
| `FEE_RECIPIENT`             | signer   | Address to receive fees                                              |
| `INTENT_GAS_BUFFER`         | `50000`  | Fixed buffer added to simulation gas for combinedGas                 |
| `PAYMENT_GAS_BUFFER`        | `70000`  | Additional combinedGas buffer when payment reimbursement is enabled  |
| `ORCHESTRATOR_OVERHEAD`     | `110000` | Gas for orchestrator work outside the self-call                      |
| `TX_GAS_BUFFER`             | `0`      | Additional buffer for tx gas calculation                             |
| `PRIORITY_FEE_PERCENTILE`   | `50`     | Fee percentile from block history                                    |
| `QUOTE_TTL_SECONDS`         | `300`    | Fee quote validity (seconds)                                         |

### Optional: Validation

| Name                           | Default | Description                           |
| ------------------------------ | ------- | ------------------------------------- |
| `INTENT_EXPIRY_BUFFER_SECONDS` | `30`    | Buffer before expiry to reject intent |

### Optional: Authentication

Protected JSON-RPC methods are controlled by a shared policy used by all enabled auth mechanisms.

`wallet_prepareUpgradeAccount` and `wallet_upgradeAccount` are always authenticated. They spend the relayer's gas, so `AUTH_PROTECTED_METHODS=none` or a list that omits them does not turn that check off. No extra env var is required.

| Name                     | Default                    | Description                                |
| ------------------------ | -------------------------- | ------------------------------------------ |
| `AUTH_PROTECTED_METHODS` | `wallet_sendPreparedCalls` | Comma-separated protected JSON-RPC methods |

#### ERC-8128 HTTP Signatures

| Name                           | Default | Description                                          |
| ------------------------------ | ------- | ---------------------------------------------------- |
| `ERC8128_ENABLED`              | `false` | Enable ERC-8128 HTTP request-signature auth provider |
| `ERC8128_MAX_VALIDITY_SECONDS` | `120`   | Max accepted signature validity window               |
| `ERC8128_CLOCK_SKEW_SECONDS`   | `30`    | Allowed clock skew for signature timestamps          |

#### Privy Access Tokens

| Name               | Default | Description                                   |
| ------------------ | ------- | --------------------------------------------- |
| `PRIVY_ENABLED`    | `false` | Enable Privy bearer-token auth provider       |
| `PRIVY_APP_ID`     | -       | Privy app id used to verify token ownership   |
| `PRIVY_APP_SECRET` | -       | Privy app secret used by server-side verifier |

Auth mode is OR across enabled providers: a protected request is authorized if any enabled provider succeeds.

Suggested rollout:

- Stage: `AUTH_PROTECTED_METHODS=wallet_sendPreparedCalls,wallet_prepareCalls`
- Prod: `AUTH_PROTECTED_METHODS=wallet_sendPreparedCalls`

Account upgrade stays on the protected list in every environment, including those two.

## Deployment

### First-time Setup

1. Create the queues:

```bash
wrangler queues create relayer-monitor-queue-stage
wrangler queues create relayer-monitor-queue-prod
```

2. Set secrets:

```bash
# Stage
wrangler secret put RPC_URL --env stage
wrangler secret put RELAYER_MNEMONIC --env stage
wrangler secret put CHAIN_IDS --env stage
wrangler secret put CONTEXT --env stage
wrangler secret put RPC_84532 --env stage
wrangler secret put RPC_137 --env stage
wrangler secret put PRIVY_APP_ID --env stage
wrangler secret put PRIVY_APP_SECRET --env stage

# Prod
wrangler secret put RPC_URL --env prod
wrangler secret put RELAYER_MNEMONIC --env prod
wrangler secret put CHAIN_IDS --env prod
wrangler secret put CONTEXT --env prod
wrangler secret put RPC_8453 --env prod
wrangler secret put RPC_137 --env prod
wrangler secret put PRIVY_APP_ID --env prod
wrangler secret put PRIVY_APP_SECRET --env prod
```

3. Deploy:

```bash
wrangler deploy --env stage
wrangler deploy --env prod
```

`wrangler.toml` has no custom domain. After deploy, attach the hostname in the Cloudflare dashboard (Workers → this worker → Domains). Set the wallet `RELAYER_URL_STAGE` or `RELAYER_URL_PROD` to `https://<that-host>`.

### Updating

```bash
wrangler deploy --env stage   # Deploy to stage
wrangler deploy --env prod    # Deploy to prod
```

### Logs

```bash
wrangler tail --env stage
wrangler tail --env prod
```

## Architecture

- **SignerDO** - Individual signer state and transaction signing (SQLite-backed)
- **SignerPoolDO** - Distributes transactions across signers (SQLite-backed)
- **IntentNonceDO** - Intent deduplication and ordering (SQLite-backed)
- **BundleStatusDO** - Transaction bundle status tracking (SQLite-backed)
- **MONITOR_QUEUE** - Processes transaction monitoring jobs

## Endpoints

Local `wrangler dev` listens on `http://127.0.0.1:8787`.

`wrangler deploy --env stage` and `wrangler deploy --env prod` do not attach a hostname. `wrangler.toml` cannot take a custom domain from an env var, so add the domain in the Cloudflare dashboard (Workers → this worker → Domains) after deploy. Set the wallet to that origin:

- `RELAYER_URL_STAGE` for stage
- `RELAYER_URL_PROD` for prod

Worker env to set before deploy (secrets or vars): `RPC_URL`, per-chain `RPC_<chainId>` (Base is `RPC_8453`; Sepolia is `RPC_84532`), `CHAIN_IDS`, `RELAYER_MNEMONIC`, and `CONTEXT` (`stage` or `prod`). Optional: `CORS_ALLOWED_ORIGINS`.
