---
name: verify-agentic-payments
description: >-
  Thin runner for the wallet CLI (tw, bun ./src/cli.ts) and the local Anvil
  scripts bun run e2e:local-payment and bun run e2e:local-escrow. Use it to
  prove a local dev USDC send or a local escrow create-and-settle. Do not use
  it for swap, bridge, or login, and do not reimplement the scripts.
---

# Verify Agentic Payments

This skill does not start a second harness. It checks the machine, then runs the repo scripts `scripts/e2e-local-payment.sh` and `scripts/e2e-local-escrow.sh`. Those scripts start Anvil, deploy, start wrangler, drive `tw`, and tear down what they started.

Run every command from the repo root. The wallet CLI in these scripts is `bun ./src/cli.ts` from `packages/wallet` (the `tw` binary).

## Launch

Node must be >= 22. Wrangler refuses Node 20. This machine has Node 22 at `/tmp/node22/bin`. Foundry `anvil`, `cast`, and `forge`, plus `bun`, `curl`, `python3`, `bc`, and `lsof`, must be on `PATH`. `bc` is required by `packages/wallet/scripts/fund-dev.sh`. `lsof` is required by `packages/relayer/scripts/dev.sh`. Ports 8545, 8546, and 8787 must be free.

`scripts/e2e-local-payment.sh` prepends `$HOME/.bun/bin` and, only when `node` is missing or older than 22, `/tmp/node22/bin`. It does not prepend Foundry. `scripts/e2e-local-escrow.sh` prepends `$HOME/.foundry/bin` and `$HOME/.bun/bin`, and the same Node 22 fallback. Put Foundry on `PATH` yourself before the payment script.

```bash
export PATH="/tmp/node22/bin:$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
bun install
bun run e2e:local-payment
bun run e2e:local-escrow
```

`bun run e2e:local-payment` is `bash scripts/e2e-local-payment.sh`. `bun run e2e:local-escrow` is `bash scripts/e2e-local-escrow.sh`. The scripts themselves start Anvil (31337 on 8545 and 41337 on 8546), run `bun run deploy:local` and `bun run make-config` in `packages/contracts`, start the wrangler relayer through `packages/relayer/scripts/dev.sh --background`, build `@agentic-payments/relayer-client`, drive the wallet CLI, and tear down the Anvil and relayer processes they started.

Do not run `packages/contracts` `bun run dev` or start Anvil by hand for these proofs. That is a different entrypoint.

## Doctor

Read-only. It does not install, deploy, or start Anvil, wrangler, or the wallet.

From the repo root, with the same `PATH` as Launch:

```bash
bash .cursor/skills/verify-agentic-payments/scripts/doctor.sh
```

Exit 0 prints one `DOCTOR PASS` line. Exit 1 prints one or more `DOCTOR FAIL` lines. The doctor fails when:

- `node` is missing, or its major version is below 22 (it does not prepend `/tmp/node22/bin` for you)
- any of `anvil`, `cast`, `forge`, `bun`, `curl`, `python3`, `bc`, or `lsof` is missing
- `ss` is missing (the e2e scripts use `ss -ltn` to decide a port is taken)
- port 8545, 8546, or 8787 already has a listener

A failure names the check. Fix `PATH` or free the port, then run the doctor again. Do not start the e2e scripts while the doctor is failing.

## Drive

One feature per command. Do not wrap them.

Local payment, from the repo root:

```bash
bun run e2e:local-payment
```

Success is exit 0 and a line that is exactly `PASS local agentic payment`.

Local escrow, from the repo root:

```bash
bun run e2e:local-escrow
```

Success is exit 0 and a line that is exactly `PASS local escrow`.

The payment script's wallet commands are `bun ./src/cli.ts account create --env dev` and `bun ./src/cli.ts send 1 <recipient> --env dev`. The escrow script's wallet commands are `bun ./src/cli.ts escrow create`, `escrow status`, and `escrow settle`, all with `--env dev`. There is no selector list. The scripts print the balance and `ASSERT` lines themselves.

## Evidence

Proof is the script's stdout, not a screenshot. Save that stdout under `/tmp` if you need to keep it. Do not commit it.

Payment proof, both required:

- the line `PASS local agentic payment`
- the USDC balance line the script prints before that, shaped `USDC sender <before> -> <after>; recipient <before> -> <after>` (base units; 1 USDC is 1000000)

Escrow proof, both required:

- the line `PASS local escrow`
- the `ASSERT` line the script prints before that, shaped `ASSERT escrow status finalized tx <settle-tx>; seller USDC <before> -> <after>; create tx <create-tx>`

The scripts also write untracked files under `/tmp` (`e2e-anvil-31337.log`, `e2e-anvil-41337.log`, `e2e-escrow-anvil-31337.log`, `e2e-escrow-anvil-41337.log`, `relayer.log`, and a `mktemp` directory named `agentic-payments-e2e.*` or `agentic-payments-e2e-escrow.*`). Those logs stay untracked. They are not the proof. The proof is the script output.

## Cleanup

Each script installs an `EXIT` trap that kills only the PIDs it started: the two Anvil processes and the relayer PID returned by `packages/relayer/scripts/dev.sh --background`, including their child processes. Do not kill by process name (`pkill anvil`, `killall wrangler`, or anything that matches a name). That can stop an Anvil or relayer this run does not own.

Cleanup does not delete evidence logs. `/tmp` anvil logs, `/tmp/relayer.log`, the temp artifact directory, and any stdout log you saved stay on disk.

## Helpers

One helper, the doctor. It must stay executable.

```bash
bash .cursor/skills/verify-agentic-payments/scripts/doctor.sh
```

No other helpers. Feature notes are under `features/`.
