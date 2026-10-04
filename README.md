# Agentic Payments

Smart accounts, a relayer, and a local wallet CLI for agent-initiated payments. Split out of a private repo. This tree is the payments surface only.

## Packages

- `packages/contracts` — `@agentic-payments/contracts`. Solidity, Foundry tests, and deploy scripts. The account contract is `Account` (EIP-7702), with Orchestrator, GuardedExecutor, Escrow, SimpleFunder, SimpleSettler, Simulator, and MultiSigSigner.
- `packages/relayer` — `@agentic-payments/relayer`. Cloudflare Worker that submits signed intents. Local dev is `packages/relayer/scripts/dev.sh` (wrangler).
- `packages/relayer-client` — `@agentic-payments/relayer-client`. viem-style client (`prepareCalls`, `sendPreparedCalls`, `upgradeAccount`, escrow helpers).
- `packages/wallet` — `@agentic-payments/wallet`. CLI binary `tw` (`bun ./src/cli.ts`). Commands: `account`, `session`, `daemon`, `permissions`, `escrow`, `send`, `swap`, `bridge`, `address`, `login`, `logout`. `tw --mcp` serves those commands over MCP. `tw --json` prints structured output.
- `packages/proto` — `@agentic-payments/proto`. Exports only `BearerTokenSchema`, `WalletSessionTokenSchema`, `ExportedDeviceSchema`, and the `ExportedDevice` type, from `schema/payments.proto`.

Workspace manager is Bun `1.3.3`. Foundry `1.5.1` is what the contract tests use.

## Local payment

From the repo root, with Anvil, cast, forge, bun, curl, python3, bc, and Node >= 22 on `PATH` (this environment's `/usr/bin/node` is 20; the script prepends `/tmp/node22/bin` when that binary exists):

```bash
bun install
bun run e2e:local-payment
```

Ports 8545, 8546, and 8787 must be free. The script starts both Anvil chains, runs `packages/contracts` `deploy:local` and `make-config`, starts the wrangler relayer, creates an account with `tw account create --env dev`, mints MockUSDC, and sends 1 USDC with `tw send`. It stops the Anvil and wrangler processes it started.

Local `e2e:local-payment` does not need any external relayer or login host. Dev uses `http://127.0.0.1:8787` unless `RELAYER_URL_DEV` is set.

Prod and stage relayer URLs are not in source. Set `RELAYER_URL_PROD` and `RELAYER_URL_STAGE` to the worker origin (Cloudflare dashboard custom domain after `wrangler deploy --env prod` or `--env stage`). Login, which the local payment path does not use, reads `AUTH_URL_PROD`, `AUTH_URL_STAGE`, or `AUTH_URL_DEV`. If unset, `tw login` says so instead of printing a URL.

Contract deploys to Base are `packages/contracts` `./scripts/sh/deploy.sh dev|stage|prod` with `RPC_84532` (Base Sepolia) or `RPC_8453` (Base). See `packages/contracts/README.md`.
