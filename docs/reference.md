# Reference

Detail moved out of the root README. A later docs site will absorb this page.

## Packages

- `packages/contracts` — `@nubl/contracts`. Solidity, Foundry tests, and deploy scripts. The account contract is `Account` (EIP-7702), with Orchestrator, GuardedExecutor, Escrow, SimpleFunder, SimpleSettler, Simulator, and MultiSigSigner.
- `packages/relayer` — `@nubl/relayer`. Cloudflare Worker that submits signed intents. Local dev is `packages/relayer/scripts/dev.sh` (wrangler).
- `packages/relayer-client` — `@nubl/relayer-client`. viem-style client (`prepareCalls`, `sendPreparedCalls`, `upgradeAccount`, escrow helpers).
- `packages/wallet` — `@nubl/wallet`. From `packages/wallet`, after the builds in the README, the CLI is `bun ./src/cli.ts`. Commands: `account`, `session`, `daemon`, `permissions`, `escrow`, `send`, `swap`, `bridge`, `address`, `login`, `logout`. `bun ./src/cli.ts --json` is incur's shorthand for `--format json`. `bun ./src/cli.ts --mcp` is an incur stdio server.
- `packages/proto` — `@nubl/proto`. Exports only `BearerTokenSchema`, `WalletSessionTokenSchema`, `ExportedDeviceSchema`, and the `ExportedDevice` type, from `schema/payments.proto`.

Workspace manager is Bun `1.3.3` (`packageManager` in the root `package.json`). Foundry `1.5.1` is what the contract tests and the e2e workflows use.

## Relayer limits and gas budgets

A USDC-paid first upgrade allows 3 prepares-or-sends per address, 8 per IP, and 8 per IPv6 /56, each per 600 seconds. The chain ceiling is 60 sends per 600 seconds; prepares do not count toward it. One chain may spend 2,000,000 gas per UTC day, holding 500,000 per in-flight broadcast. The signed type-4 gas limit cannot exceed that hold, including when a stale broadcast is replaced, and a quote whose estimate needs more is refused. The signed USDC ceiling is 5. Stage and prod require `FEE_RECIPIENT`.

## MCP tool ids

`bun ./src/cli.ts --mcp` from `packages/wallet` registers one tool per leaf command. The id is the path joined with `_`. The server returns these 34 ids:

`account_balance`, `account_change-password`, `account_create`, `account_delegate`, `account_export`, `account_history`, `account_nonce`, `account_passkey`, `account_status`, `address`, `bridge`, `daemon_lock`, `daemon_start`, `daemon_status`, `daemon_stop`, `daemon_unlock`, `escrow_create`, `escrow_refund`, `escrow_settle`, `escrow_status`, `login`, `logout`, `permissions_grant`, `permissions_list`, `permissions_revoke`, `permissions_show`, `send`, `session_create`, `session_export`, `session_import`, `session_list`, `session_revoke`, `session_rotate`, `swap`.

## Confirmation phrases

`account create`, `account delegate`, `send`, escrow create and refund, private-key export, session export, full-access session and permission changes (including a spend period shorter than a day, a non-USDC token, `increaseAllowance`, or combined USDC spend above 10 per day), daemon unlock of a full-access or unreadable session, `session rotate --narrow`, revoking a full-access session, passkey, and oracle-key escrow settle are refused over MCP and on a non-TTY invocation until a human types the confirmation phrase in a terminal.

New accounts get a narrow session (USDC transfer and approve, escrow, refund, settler write, escrow settle, 10 USDC per day).

`account create` and `account delegate` use `CREATE FULL ACCESS SESSION`. `send`, escrow create, and escrow refund use `SEND USDC`. Private-key export (`account export --show-private` and `session export`) uses `EXPORT PRIVATE KEYS`. `account passkey` uses `AUTHORIZE PASSKEY`. Oracle-key escrow settle uses `SIGN ESCROW SETTLEMENT`. The raw private key arguments for passkey and oracle settle are not accepted over MCP.

A local PTY can type the phrase; MCP still refuses. The session daemon socket does not return raw keys.

## Swap and bridge

Swap and bridge need a dedicated session from `bun ./src/cli.ts session create <name> --swap` in `packages/wallet`, which requires `CREATE SWAP SESSION` at an interactive terminal, and they do not use a wildcard. A swap key can move an NFT or a vault share if the account has approved the Relay router, the approval proxy, or the depository. Revoke those approvals with the root key. The wallet does not scan for them. Swap and bridge ignore `yes` outside that terminal.

Swap, bridge, and login have no local end-to-end script: `bun ./src/cli.ts swap` and `bun ./src/cli.ts bridge` from `packages/wallet` call relay.link (`https://api.testnets.relay.link` on dev, `https://api.relay.link` otherwise), and `bun ./src/cli.ts login` needs `AUTH_URL_DEV`, `AUTH_URL_STAGE`, or `AUTH_URL_PROD`. Those quotes are allowlisted and simulated before signing, and a calldata change after confirmation is shown again.

## Environment variables

Local `e2e:local-payment` does not need any external relayer or login host. `--env dev` is local Anvil only. Its default chain is `anvil`, and the zero fee ceiling is signed only on chain ids 31337 and 41337. `--env dev` on a published chain, including `--chain base` and Base Sepolia, refuses to sign: that env pays with the zero address, and off those two chain ids the payer and payment token must not be zero. Use `--env stage` for Base Sepolia and `--env prod` for Base. Dev uses `http://127.0.0.1:8787` unless `RELAYER_URL_DEV` is set. Prod and stage relayer URLs are not in source. Set `RELAYER_URL_PROD` and `RELAYER_URL_STAGE` to an `https` worker origin (loopback `http` is still accepted). `--env dev` may use plain `http` for a loopback host, or for local chain 31337/41337 when that chain's orchestrator is not in the deployments JSON. Login, which the local payment path does not use, reads `AUTH_URL_PROD`, `AUTH_URL_STAGE`, or `AUTH_URL_DEV`. If unset, `bun ./src/cli.ts login` says so instead of printing a URL.

## EIP-712

Before it signs, the wallet recomputes the EIP-712 `Intent` digest and signs that rebuilt typed data. The domain is `Orchestrator` version `0.5.5` with only `name`, `version`, `chainId`, and `verifyingContract`. The digest binds the requested calls, the nonce read from the account, a wallet-chosen expiry (one hour, never `0`), and fee caps. Combined gas must sit under a ceiling from the wallet's own estimate. An RPC gas estimate cannot raise that ceiling above twice the local formula. The quote that will be executed has to match that same intent. Off local chains the signed fee cap is the accepted quote plus 5% (at least 0.001 USDC), paid by the account in USDC. A quote, or that quote plus margin, above 5 USDC is refused. A zero, missing, or non-numeric quote is refused off local instead of falling back to the 5 USDC ceiling. The CLI prints the fee token, the USDC amount, and that the cap expires in 1 hour, in the human output and in `--json`. Local Anvil is not in `addresses.json`; chain 31337 reads `ORCHESTRATOR_31337` and `ACCOUNT_PROXY_31337` from the environment or from `packages/contracts/deployments/envs/local/.env` after `make-config`. Account create and delegate authorize only that local proxy, at the EOA nonce from the wallet RPC, and sign a SignedCall rebuilt from the keys the wallet asked to authorize. Relayer HTTP calls use `redirect: manual` and refuse a 3xx.

## Local payment and deploys

From the repo root, with Anvil, cast, forge, bun, curl, python3, bc, lsof, and ss, and Node >= 22 on `PATH`:

```bash
bun install
bun run e2e:local-payment
```

Ports 8545, 8546, and 8787 must be free. The script starts both Anvil chains, runs `packages/contracts` `deploy:local` and `make-config`, starts the wrangler relayer, creates an account with `bun ./src/cli.ts account create --env dev`, mints MockUSDC, and sends 1 USDC with `bun ./src/cli.ts send`. It stops the Anvil and wrangler processes it started. The other local script is `bun run e2e:local-escrow`.

Contract deploys to Base Sepolia are `packages/contracts` `./scripts/sh/deploy.sh stage` with `RPC_84532`. Base mainnet is `./scripts/sh/deploy.sh prod` with `RPC_8453`. See [packages/contracts/README.md](../packages/contracts/README.md). Stage launch: [base-sepolia-launch.md](runbooks/base-sepolia-launch.md). The stage relayer reads `deployments/envs/stage/`.
