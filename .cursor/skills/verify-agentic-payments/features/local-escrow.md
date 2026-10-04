# Local escrow

One local USDC escrow on Anvil chain 31337: create, status, settle, then the seller balance check. Same Anvil, deploy, and wrangler relayer as local payment. Wallet CLI on `--env dev`.

## Sub-features

- Create a local account and delegate it. That address is the buyer.
- Create a 1 USDC escrow to seller `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (Anvil account #1), oracle the Anvil deployer (account #0), deadline `1h`.
- Read on-chain status `created`.
- Settle with the script's `TW_ORACLE_PRIVATE_KEY` (the public Anvil default key, the same one local deploy uses).
- Assert status `finalized` and that the seller's USDC balance rose by 1000000.

## How to get to it (user POV)

You are on the repo root. The stack is already up only if you are driving `tw` by hand. The e2e script brings the stack up for you. By hand, from `packages/wallet`, with `TW_PASSWORD` set and `TW_ORACLE_PRIVATE_KEY` set to the Anvil deployer key:

```bash
bun ./src/cli.ts account create --env dev --keystore-path "$KEYSTORE" --format json
bun ./src/cli.ts escrow create 1 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --oracle "$ORACLE" --deadline 1h --env dev --keystore-path "$KEYSTORE" --format json
bun ./src/cli.ts escrow status "$ESCROW_ID" --env dev
bun ./src/cli.ts escrow settle "$ESCROW_ID" --settlement-id "$ORDER_ID" --oracle "$ORACLE" --env dev --keystore-path "$KEYSTORE" --format json
```

`tw escrow create` takes the amount and the seller. `--oracle` and `--deadline` are required. `tw escrow settle` needs the escrow id, `--settlement-id` (the order id from create), and `--oracle`. Prefer `TW_ORACLE_PRIVATE_KEY` over putting the key on the command line. Always pass `--env dev`.

After settle, status is `finalized` and the seller balance is 1000000 base units higher than before create. That is the assertion you are looking for.

## Driving it with the e2e script

From the repo root, after Launch in `SKILL.md`:

```bash
bun run e2e:local-escrow
```

That is `bash scripts/e2e-local-escrow.sh`. The script exports every `NAME=0x…` address line from `packages/contracts/deployments/envs/local/.env`, sets `TW_PASSWORD` and `TW_ORACLE_PRIVATE_KEY`, runs the CLI commands above, and checks balances. You do not pass selectors.

Wait for exit 0 and the line `PASS local escrow`. The line just above it starts with `ASSERT escrow status finalized` and includes the seller USDC balances and the create tx.

## Gotchas

- `tw swap` and `tw bridge` call relay.link. They are not in this script. A local escrow pass says nothing about swap or bridge.
- `tw login` needs a browser login token. Escrow in this script uses `account create` on `--env dev`, not a login profile.
- Pass `--env dev` every time. Omitting `--env` is a separate PR. Do not depend on it. On this branch the flag still defaults to `prod`.
- `packages/contracts` `bun run dev` needs `nc` on `PATH`. This script does not use that entrypoint. It starts its own Anvil processes. Do not point it at a reused `bun run dev` stack.
- `packages/relayer/scripts/dev.sh` needs `lsof`. If `lsof` is missing, the relayer never starts and escrow never reaches create.
- Local addresses are not in `addresses.json`. `make-config` removes every `local*` key before writing that file, because it is committed. The addresses live in `packages/contracts/deployments/envs/local/.env`. This script exports that file (`Exported N local address keys`) and rebuilds `@agentic-payments/contracts` so `getAddressesWithFallback` can see them. If that export line is missing, stop. Do not copy addresses into `addresses.json`.
