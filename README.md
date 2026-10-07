# Agentic Payments

Smart accounts, a relayer, and a local wallet CLI for agent-initiated payments. This tree is the payments surface only.

## Packages

- `packages/contracts` — `@nubl/contracts`. Solidity, Foundry tests, and deploy scripts. The account contract is `Account` (EIP-7702), with Orchestrator, GuardedExecutor, Escrow, SimpleFunder, SimpleSettler, Simulator, and MultiSigSigner.
- `packages/relayer` — `@nubl/relayer`. Cloudflare Worker that submits signed intents. Local dev is `packages/relayer/scripts/dev.sh` (wrangler).
- `packages/relayer-client` — `@nubl/relayer-client`. viem-style client (`prepareCalls`, `sendPreparedCalls`, `upgradeAccount`, escrow helpers).
- `packages/wallet` — `@nubl/wallet`. CLI binary `tw` (`bun ./src/cli.ts`). Commands: `account`, `session`, `daemon`, `permissions`, `escrow`, `send`, `swap`, `bridge`, `address`, `login`, `logout`. `tw --json` prints structured output. `tw --mcp` is an incur stdio server. Tool ids are the leaf names joined with `_`: `account_balance`, `account_nonce`, `account_history`, `account_status`, `account_create`, `account_delegate`, `account_export`, `account_change-password`, `session_create`, `session_export`, `session_import`, `session_list`, `session_rotate`, `session_revoke`, `daemon_start`, `daemon_stop`, `daemon_unlock`, `daemon_lock`, `daemon_status`, `permissions_list`, `permissions_show`, `permissions_grant`, `permissions_revoke`, `escrow_create`, `escrow_status`, `escrow_settle`, `escrow_refund`, `send`, `swap`, `bridge`, `address`, `login`, `logout`. `account create`, `account delegate`, `send`, escrow create and refund, private-key export, session export, full-access session and permission changes (including a spend period shorter than a day, or a non-USDC token), passkey, and oracle-key escrow settle are refused over MCP and on a non-TTY `tw` until a human types the confirmation phrase in a terminal. Swap and bridge ignore `yes` outside that terminal. A local PTY can type the phrase; MCP still refuses. The session daemon socket does not return raw keys.
- `packages/proto` — `@nubl/proto`. Exports only `BearerTokenSchema`, `WalletSessionTokenSchema`, `ExportedDeviceSchema`, and the `ExportedDevice` type, from `schema/payments.proto`.

Workspace manager is Bun `1.3.3`. Foundry `1.5.1` is what the contract tests use.

## Local payment

From the repo root, with Anvil, cast, forge, bun, curl, python3, bc, and Node >= 22 on `PATH`:

```bash
bun install
bun run e2e:local-payment
```

Ports 8545, 8546, and 8787 must be free. The script starts both Anvil chains, runs `packages/contracts` `deploy:local` and `make-config`, starts the wrangler relayer, creates an account with `tw account create --env dev`, mints MockUSDC, and sends 1 USDC with `tw send`. It stops the Anvil and wrangler processes it started.

Local `e2e:local-payment` does not need any external relayer or login host. Dev uses `http://127.0.0.1:8787` unless `RELAYER_URL_DEV` is set. The other local script is `bun run e2e:local-escrow`. Swap, bridge, and login have no local end-to-end script: `tw swap` and `tw bridge` call relay.link (`https://api.testnets.relay.link` on dev, `https://api.relay.link` otherwise), and `tw login` needs `AUTH_URL_DEV`, `AUTH_URL_STAGE`, or `AUTH_URL_PROD`.

Prod and stage relayer URLs are not in source. Set `RELAYER_URL_PROD` and `RELAYER_URL_STAGE` to the worker origin (Cloudflare dashboard custom domain after `wrangler deploy --env prod` or `--env stage`). Login, which the local payment path does not use, reads `AUTH_URL_PROD`, `AUTH_URL_STAGE`, or `AUTH_URL_DEV`. If unset, `tw login` says so instead of printing a URL.

Contract deploys to Base are `packages/contracts` `./scripts/sh/deploy.sh dev|stage|prod` with `RPC_84532` (Base Sepolia) or `RPC_8453` (Base). See `packages/contracts/README.md`.
