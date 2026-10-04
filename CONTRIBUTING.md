# Contributing

This repo is the Agentic Payments stack: `packages/contracts`, `packages/relayer`, `packages/relayer-client`, `packages/wallet` (`tw`), and `packages/proto`.

## Setup

- Bun 1.3.3 (`packageManager` in the root `package.json`)
- Foundry 1.5.1 (`forge`, `cast`, `anvil`) for contracts and the local payment flow
- Node >= 22 on `PATH` (the relayer's wrangler does not start on Node 20)
- `curl`, `python3`, and `bc` for `bun run e2e:local-payment`

```bash
bun install
```

## Tests

From the repo root unless noted:

```bash
# wallet
bun run --cwd packages/contracts build:contracts
bun run --cwd packages/relayer-client build
bun run --cwd packages/wallet test

# relayer
bun run --cwd packages/relayer test:run

# contracts
bun run --cwd packages/contracts test
# forge test also works if your shell is already in packages/contracts

# local payment (Anvil, deploy, wrangler, tw send)
bun run e2e:local-payment
```

`e2e:local-payment` needs ports 8545, 8546, and 8787 free. It starts Anvil and the wrangler relayer and stops the processes it started. Swap and bridge have no local end-to-end script: `tw swap` and `tw bridge` call relay.link (`https://api.testnets.relay.link` on dev, `https://api.relay.link` otherwise). Login has no local end-to-end script either: `tw login` needs `AUTH_URL_DEV`, `AUTH_URL_STAGE`, or `AUTH_URL_PROD`.

Contract deploys use `packages/contracts/scripts/sh/deploy.sh`. See `packages/contracts/README.md`. Do not look for a Makefile.

## Reporting vulnerabilities

See `SECURITY.md`. Email [security@nubl.ai](mailto:security@nubl.ai).
