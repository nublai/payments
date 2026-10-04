# AGENTS.md

Payments monorepo. Packages that exist:

- `packages/contracts` — Solidity (`Account`, Orchestrator, GuardedExecutor, Escrow, SimpleFunder, SimpleSettler, Simulator, MultiSigSigner, LayerZeroSettler). Deploy with `./scripts/sh/deploy.sh` from that package. Tests: `forge test` or `bun run test`.
- `packages/relayer` — Cloudflare Worker. Local: `packages/relayer/scripts/dev.sh`. Tests: `bun run test:run`. Deploy: `wrangler deploy --env stage` or `--env prod`. The Cloudflare account is `wrangler login` or `CLOUDFLARE_ACCOUNT_ID`, not a value in `wrangler.toml`.
- `packages/relayer-client` — client for prepare, send, upgrade, and escrow.
- `packages/wallet` — CLI `tw` (`bun ./src/cli.ts`). Groups: `account`, `session`, `daemon`, `permissions`, `escrow`, plus `send`, `swap`, `bridge`, `address`, `login`, `logout`. `tw --mcp` exposes the leaf tools listed in the root README.
- `packages/proto` — `BearerToken`, `WalletSessionToken`, `ExportedDevice` only.

There is no `@agentic-payments/deployments`, `@agentic-payments/web3`, `@agentic-payments/sdk`, or `@agentic-payments/utils` package in this tree.

Local payment: `bun run e2e:local-payment` from the root. Needs Node >= 22, Foundry, bun, Anvil, cast, forge, curl, python3, and bc. Ports 8545, 8546, and 8787 must be free. Local escrow is `bun run e2e:local-escrow`. Swap, bridge, and login have no local end-to-end script: `tw swap` and `tw bridge` call relay.link, and `tw login` needs `AUTH_URL_DEV`, `AUTH_URL_STAGE`, or `AUTH_URL_PROD`.

Do not rename `TOWNS_ACCOUNT_STORAGE`, `TOWNS_ACCOUNT_UPGRADE_HOOK_ID`, or `TOWNS_GUARDED_EXECUTOR_KEY_STORAGE`. Those strings are keccak storage-slot seeds; changing them moves deployed storage. `@towns-protocol/diamond` is an upstream package, not this product's name; leave that import. Relayer and login hosts are env vars (`RELAYER_URL_DEV`, `RELAYER_URL_STAGE`, `RELAYER_URL_PROD`, `AUTH_URL_DEV`, `AUTH_URL_STAGE`, `AUTH_URL_PROD`).
