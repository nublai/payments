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

| Name                    | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `RPC_URL`               | JSON-RPC endpoint (e.g. `https://base-sepolia.g.alchemy.com/v2/...`) |
| `RELAYER_MNEMONIC`      | HD wallet mnemonic for deriving signer keys                          |
| `CHAIN_IDS`             | Comma-separated chain IDs (e.g. `8453,137`)                          |
| `QUOTE_SIGNING_SECRET`  | HMAC secret for quote integrity. Required on stage and prod.         |

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
| `FEE_RECIPIENT`             | signer locally; required on stage and prod | Address that receives USDC fees. Stage and prod refuse to start without a non-zero address, because paid-upgrade simulation and the broadcast must pay the same recipient. |
| `INTENT_GAS_BUFFER`         | `50000`  | Fixed buffer added to simulation gas for combinedGas                 |
| `PAYMENT_GAS_BUFFER`        | `70000`  | Additional combinedGas buffer when payment reimbursement is enabled  |
| `ORCHESTRATOR_OVERHEAD`     | `110000` | Gas for orchestrator work outside the self-call                      |
| `TX_GAS_BUFFER`             | `0`      | Additional buffer for tx gas calculation                             |
| `PRIORITY_FEE_PERCENTILE`   | `50`     | Fee percentile from block history                                    |
| `QUOTE_TTL_SECONDS`         | `300`    | Fee quote validity (seconds)                                         |

`QUOTE_SIGNING_SECRET` is required when `CONTEXT` is anything other than `local` (including when `CONTEXT` is unset or `dev`). The relayer signs each quote with HMAC-SHA256 and rejects a send whose quote does not verify. It also recomputes `paymentAmount` from `txGas`, `maxFeePerGas`, and `nativeRate`. The client-supplied `paymentAmount` is not collected. If fee history fails, `wallet_prepareCalls` fails instead of signing a zero fee. Outside local, a quote whose recomputed fee is 0 is not signed, and a payer-set quote that recomputes to 0 is rejected on send. Only `CONTEXT=local` may omit the secret; quote HMAC is then skipped, and a zero fee quote can still be returned. `CONTEXT=dev` still selects the Base Sepolia deployment files. It does not skip the secret, allow an http JWKS URL, or leave ERC-8128 open. Do not copy a local secret into stage or prod. Set a unique value with `wrangler secret put QUOTE_SIGNING_SECRET --env stage` (and `--env prod`).

### Optional: Validation

| Name                           | Default | Description                           |
| ------------------------------ | ------- | ------------------------------------- |
| `INTENT_EXPIRY_BUFFER_SECONDS` | `30`    | Buffer before expiry to reject intent |

### Optional: Authentication

Protected JSON-RPC methods are controlled by a shared policy used by all enabled auth mechanisms.

`wallet_prepareUpgradeAccount`, `wallet_upgradeAccount`, `wallet_issueBindNonce`, and `wallet_bindAccount` are always authenticated. Upgrade methods spend the relayer's gas, so `AUTH_PROTECTED_METHODS=none` or a list that omits them does not turn that check off. The authenticated identity must be the account (ERC-8128), a Privy user with a linked account of type `wallet` whose address checksum-matches that account, or an OIDC user whose binding contains that account. A wallets claim counts only when `OIDC_WALLETS_CLAIM_ENABLED=true`. A Privy smart wallet does not match. The delegation must be the configured account proxy, the authorization nonce must be the account's pending nonce, and arbitrary preCalls are rejected. Key initialization (`authorize`, `setCanExecute`, `setSpendLimit`) is still allowed because `tw account create` / `tw account delegate` and the local payment and escrow flows submit it. Gas, max fee, and priority fee are capped before the upgrade is signed. An upgrade reserves its identity, IP, IPv6 /56, and chain slots in the same step that decides to broadcast, and releases them only when the signer returns before `eth_sendRawTransaction`. Per 10-minute window the upgrade ceilings are 5 per identity, 100 per IP, and 2,000 per chain. Prepare is 10, 400, and 2,000. Identity buckets are `privy:<user id>` and `oidc:<issuer>:<sub>`. A deploy that changes Privy's bucket from the raw user id to `privy:<user id>` resets in-flight windows once. IPv6 is bucketed by /64 and by /56, both at that IP ceiling, after the text form is normalized. An IPv4 or IPv4-mapped address keeps a single IP bucket and has no /56 bucket. No extra env var is required for the numeric ceilings.

| Name                     | Default                    | Description                                |
| ------------------------ | -------------------------- | ------------------------------------------ |
| `AUTH_PROTECTED_METHODS` | `wallet_sendPreparedCalls` | Comma-separated protected JSON-RPC methods |

#### ERC-8128 HTTP Signatures

| Name                           | Default | Description                                          |
| ------------------------------ | ------- | ---------------------------------------------------- |
| `ERC8128_ENABLED`              | `false` | Enable ERC-8128 HTTP request-signature auth provider |
| `ERC8128_MAX_VALIDITY_SECONDS` | `120`   | Max accepted signature validity window               |
| `ERC8128_CLOCK_SKEW_SECONDS`   | `30`    | Allowed clock skew for signature timestamps          |
| `ERC8128_ALLOWED_SIGNERS`      | empty   | Comma-separated addresses allowed to sign HTTP requests |

Outside `local` and `dev`, a recovered ERC-8128 key is accepted only when one of these is true:

- the address is in `ERC8128_ALLOWED_SIGNERS`, or
- the address is the intent EOA (`from` on prepare, `intent.eoa` on send), or
- the address is a live secp256k1 key registered on that account (`Account.getKey`). The relayer reads this from its own RPC. A client-supplied `session_key` or quote `authSigner` is not accepted by itself.

`prepareCalls` writes `authSigner` only when `session_key` is that EOA or a live on-chain key. Send checks the HTTP signer against the quote only after the quote HMAC verifies. In one JSON-RPC batch, every protected method other than `wallet_prepareCalls` and `wallet_sendPreparedCalls` requires the allowlist. A prepare or send binding does not authorize those methods. An empty allowlist is not "any key". `CHAIN_IDS` must be non-empty; an empty list does not mean every chain. Local and dev accept any recovered key when the allowlist is unset, which is what `scripts/dev.sh` relies on. If the allowlist is set, it is enforced in every context, including local. Invalid entries fail worker startup.

#### Privy Access Tokens

| Name               | Default | Description                                   |
| ------------------ | ------- | --------------------------------------------- |
| `PRIVY_ENABLED`    | `true`  | Set to `false` to turn Privy off. Unset stays on. |
| `PRIVY_APP_ID`     | -       | Privy app id used to verify token ownership   |
| `PRIVY_APP_SECRET` | -       | Privy app secret used by server-side verifier |

Startup still requires `PRIVY_APP_ID` and `PRIVY_APP_SECRET` only when `PRIVY_ENABLED=true`. An unset flag enables the provider and does not by itself fail boot; a Privy token is rejected when those secrets are missing.

#### OIDC Access Tokens

WorkOS is the first issuer. Verification uses `jose` (`jwtVerify` against a module-scoped `createRemoteJWKSet`). There is no WorkOS SDK. `iss` must equal `OIDC_ISSUER`. `exp` is required. `nbf` and `exp` allow 60 seconds of clock skew. Algorithms are RS256 and ES256 only. When `aud` is present it is passed to `jwtVerify` and must be `OIDC_CLIENT_ID`. An array `aud` must also set `azp` to that client id. `client_id` is accepted only when `aud` is absent, which is the WorkOS session-token shape.

`sub` is the user id. `provider` is `oidc`. An address-shaped `sub` does not own that account. Wallet addresses come from `WalletBindingDO`. Ownership is global across the chains this worker serves: one address maps to one `(iss, sub)` everywhere, because the address is one key. The signed chain id stops nonce replay. It does not split ownership. The wallets claim is off unless `OIDC_WALLETS_CLAIM_ENABLED=true`. An empty `OIDC_WALLETS_CLAIM` stays off. When the flag is on, a claim address the table has already given to another `(iss, sub)` is refused.

`wallet_issueBindNonce` and `wallet_bindAccount` are always on the auth-protected list and are rate-limited per subject and per IP. The caller must present an OIDC access token. `wallet_issueBindNonce` returns a single-use nonce, an EIP-191 message (`Bind address X to sub Y`, plus issuer, nonce, chain id, expiry, and environment), and the EIP-712 typed data. The domain is `Nubl Relayer`, version `1`, with a `salt` of `keccak256` of `CONTEXT`. Unset or blank `CONTEXT` refuses the nonce instead of using the prod salt. `wallet_bindAccount` accepts `scheme` `eip712` (default) or `eip191`. Used and expired nonces are deleted. Each subject may have 3 open nonces and 4 bindings. Per 10-minute window: 5 nonce issues and 5 binds per subject, 20 of each per IP. A full IP bucket does not consume the subject window.

These OIDC values are public. Do not store them with `wrangler secret put`. If `OIDC_ENABLED=true` and any of issuer, JWKS URL, or client id is missing, the worker fails startup. The issuer must be an http(s) URL. The JWKS URL must be https, except `CONTEXT=local`, which may use http. `CONTEXT=dev` may not.

| Name                        | Default   | Description                                      |
| --------------------------- | --------- | ------------------------------------------------ |
| `OIDC_ENABLED`              | `false`   | Enable the OIDC bearer-token provider            |
| `OIDC_ISSUER`               | -         | Expected `iss`                                   |
| `OIDC_JWKS_URL`             | -         | JWKS document used by `createRemoteJWKSet`       |
| `OIDC_CLIENT_ID`            | -         | Accepted `aud`, `azp`, or `client_id`            |
| `OIDC_WALLETS_CLAIM_ENABLED`| `false`   | Turn on the signed wallets claim                 |
| `OIDC_WALLETS_CLAIM`        | `wallets` | Claim name when the flag is on. Empty means off. |

Both providers can be on at once. A token whose `iss` is `OIDC_ISSUER` is verified as OIDC and is not sent to Privy. Any other bearer token is left to Privy.

OIDC JWKS fetch failures, including a jose `JWKSTimeout` (`request timed out`), emit `IDP_UNAVAILABLE`. Privy upstream failures still emit `PRIVY_API_UNAVAILABLE`. Clients should treat both codes as identity-provider unavailable. The server does not rewrite one into the other. Stage and prod set `PRIVY_ENABLED=true` in wrangler. That makes startup require `PRIVY_APP_ID` and `PRIVY_APP_SECRET`. Set the var to `false` instead when those secrets are not ready.

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
wrangler secret put QUOTE_SIGNING_SECRET --env stage
wrangler secret put RPC_84532 --env stage
wrangler secret put RPC_137 --env stage
wrangler secret put PRIVY_APP_ID --env stage
wrangler secret put PRIVY_APP_SECRET --env stage

# Prod
wrangler secret put RPC_URL --env prod
wrangler secret put RELAYER_MNEMONIC --env prod
wrangler secret put CHAIN_IDS --env prod
wrangler secret put CONTEXT --env prod
wrangler secret put QUOTE_SIGNING_SECRET --env prod
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
- **HttpAuthNonceDO** - Single-use HTTP auth nonces (SQLite-backed)
- **WalletBindingDO** - Global OIDC wallet bindings (one SQLite Durable Object, not D1)
- **MONITOR_QUEUE** - Processes transaction monitoring jobs

## Endpoints

Local `wrangler dev` listens on `http://127.0.0.1:8787`.

`wrangler deploy --env stage` and `wrangler deploy --env prod` do not attach a hostname. `wrangler.toml` cannot take a custom domain from an env var, so add the domain in the Cloudflare dashboard (Workers → this worker → Domains) after deploy. Set the wallet to that origin:

- `RELAYER_URL_STAGE` for stage
- `RELAYER_URL_PROD` for prod

Worker env to set before deploy (secrets or vars): `RPC_URL`, per-chain `RPC_<chainId>` (Base is `RPC_8453`; Sepolia is `RPC_84532`), `CHAIN_IDS`, `RELAYER_MNEMONIC`, `CONTEXT` (`stage` or `prod`), and `QUOTE_SIGNING_SECRET`. Optional: `CORS_ALLOWED_ORIGINS`. If `ERC8128_ENABLED=true`, set `ERC8128_ALLOWED_SIGNERS` for operator keys that are not the user's account and not a key registered on that account. The on-chain key check uses the same RPC. Stage and prod set `PRIVY_ENABLED=true`, which requires `PRIVY_APP_ID` and `PRIVY_APP_SECRET` at startup. Unset still means on in code; set `false` to turn Privy off. OIDC is off until `OIDC_ENABLED=true`, and then `OIDC_ISSUER`, `OIDC_JWKS_URL`, and `OIDC_CLIENT_ID` are required public vars (not secrets). The wallets claim stays off until `OIDC_WALLETS_CLAIM_ENABLED=true`. Stage and prod need a worker redeploy to pick up this code, plus those env values, and a new Durable Object migration (`WalletBindingDO`). No contract redeploy. No new secret. The Privy rate-limit bucket key changes from the raw user id to `privy:<user id>`, which resets in-flight identity windows once. In-flight quotes signed without the secret, and in-flight quotes whose recomputed fee is 0, are rejected until the client calls `wallet_prepareCalls` again.
