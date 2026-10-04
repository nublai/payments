# Local payment

One local agentic USDC payment on Anvil chain 31337, through the wrangler relayer, using the wallet CLI on `--env dev`.

## Sub-features

- Create a local account and delegate it on dev.
- Mint MockUSDC to that account (the script does this; it is not a `tw` command).
- Send 1 USDC to the Anvil recipient `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`.

## How to get to it (user POV)

You are on the repo root. Dependencies are installed. Anvil and the relayer are not something you start yourself when you use the e2e script. If you were driving `tw` by hand against an already-running local stack, the commands are:

```bash
export TW_PASSWORD="e2e-local-payment"
cd packages/wallet
bun ./src/cli.ts account create --env dev --keystore-path "$KEYSTORE" --format json
bun ./src/cli.ts send 1 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --env dev --keystore-path "$KEYSTORE" --format json
```

`tw` is that CLI (`packages/wallet` bin `tw`, source `bun ./src/cli.ts`). Always pass `--env dev`. The amount is `1` USDC. The recipient above is the one the local payment script uses (Anvil account #1).

## Driving it with the e2e script

From the repo root, after Launch in `SKILL.md`:

```bash
bun run e2e:local-payment
```

That is `bash scripts/e2e-local-payment.sh`. The script creates the keystore under a fresh `/tmp/agentic-payments-e2e.*` directory, sets `TW_PASSWORD=e2e-local-payment`, runs the two CLI commands above, mints 25 MockUSDC with `packages/wallet/scripts/fund-dev.sh`, and checks balances. You do not pass a recipient or a selector.

Wait for exit 0 and the line `PASS local agentic payment`. The balance line just above it looks like `USDC sender <before> -> <after>; recipient <before> -> <after>`.

## Gotchas

- `tw swap` and `tw bridge` call relay.link (`https://api.testnets.relay.link` on dev, `https://api.relay.link` otherwise). They are not in this script. Do not treat a payment pass as a swap or bridge pass.
- `tw login` needs a browser login token (`--token-stdin`, or an interactive paste after the auth URL). Local payment does not log in. Unset `AUTH_URL_DEV` is not a payment failure.
- Pass `--env dev` on every `tw` command. Omitting `--env` is a separate PR. Do not depend on that PR. On this branch a missing `--env` still defaults to `prod`, which is not the local relayer.
- `packages/contracts` `bun run dev` (`scripts/sh/dev.sh`) refuses to start unless `nc` is on `PATH`. This payment script does not call that script. It starts Anvil itself. Do not switch to `bun run dev` to "help" it.
- The payment script starts the relayer with `packages/relayer/scripts/dev.sh --background`. That script exits if `lsof` is not on `PATH`.
- Local deploy addresses are not stored in `packages/contracts/deployments/addresses.json`. `make-config` writes `packages/contracts/deployments/envs/local/.env` and then deletes `local*` keys from `addresses.json`. This payment script does not export that env file. The escrow script does. Do not expect payment to print `Exported N local address keys`.
