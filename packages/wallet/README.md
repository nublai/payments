# tw — Wallet CLI

Your keys. Your account. No signup. No login. Just run it.

`tw` is a local-first CLI for managing smart accounts, session keys, and on-chain permissions on Agentic Payments. It works for humans at the terminal and for agents over `--json` or `--mcp`.

```bash
bunx @nubl/wallet --help
```

---

## Quick Start

From the repo root, install dependencies and run the local payment script. That is the path that brings up Anvil and the local relayer, creates an account, and sends USDC. `--env dev` uses `http://127.0.0.1:8787` unless `RELAYER_URL_DEV` is set.

```bash
bun install
bun run e2e:local-payment
```

Needs Anvil, cast, forge, bun, curl, python3, bc, and Node >= 22 on `PATH`. Ports 8545, 8546, and 8787 must be free. The script starts both Anvil chains, runs `packages/contracts` `deploy:local` and `make-config`, starts the wrangler relayer, creates an account with `tw account create --env dev`, mints MockUSDC, and sends 1 USDC with `tw send`. It stops the Anvil and wrangler processes it started.

Any `tw` command with `--env dev` needs that local relayer already running. The script above starts the stack and then stops it, so run the script itself rather than those commands on their own. Omitting `--env` is an error. Pass `--env prod`, `--env stage`, or `--env dev`.

No custody service. No API key. Everything runs locally with encrypted keystores.

Relayer and login hosts are environment variables, not source constants. `RELAYER_URL_DEV` overrides local `http://127.0.0.1:8787`. `RELAYER_URL_STAGE` and `RELAYER_URL_PROD` are required for those environments. `tw login` reads `AUTH_URL_DEV`, `AUTH_URL_STAGE`, or `AUTH_URL_PROD` and errors when the one for the selected env is unset. Local sends do not use login. Swap, bridge, and login have no local end-to-end script: `tw swap` and `tw bridge` call relay.link (`https://api.testnets.relay.link` on dev, `https://api.relay.link` otherwise), and login needs the `AUTH_URL_*` variable for the selected environment.

---

## How It Works

`tw` manages a local keystore that holds your root key and session keys. Your root key creates and controls your on-chain smart account. Session keys are scoped signers — they can send transactions through the relayer without exposing your root key.

```text
~/.config/agentic-payments/tw/profiles/<env>/<profile>/default.keystore.json
~/.config/agentic-payments/tw/profiles/<env>/<profile>/sessions/<session-name>.json
```

For agents, the session daemon keeps decrypted keys in memory for a bounded duration so automated workflows can sign without prompting for a password on every call.

---

## Commands

### Root Command Surface

```text
tw address
tw bridge
tw daemon <lock|start|status|stop|unlock>
tw login
tw logout
tw permissions <grant|list|revoke|show>
tw send
tw session <create|export|import|list|revoke|rotate>
tw swap
tw escrow <create|refund|settle|status>
tw account <balance|change-password|create|delegate|export|history|nonce|status>
```

### Account

#### `account create`

```bash
tw account create --profile agent --env prod
tw account create --resume --profile agent --env prod
echo "my-password" | tw account create --password-stdin --json --env prod
tw account create --keystore-path ~/.config/agentic-payments/tw/profiles/prod/team/default.keystore.json --env prod
```

#### `account status` / `account balance` / `account nonce` / `account history`

```bash
tw account status --profile agent --json --env prod
tw account balance --profile agent --env prod
tw account balance --profile agent --chain polygon --env prod
tw account nonce --profile agent --env prod
tw account history --profile agent --env prod
tw account history --address 0x... --limit 10 --offset 20 --env prod
tw account history --chain base,polygon --json --env prod
```

`--limit` defaults to 20 (max 100). `offset + limit` must be <= 1000.

#### `account delegate`

```bash
echo "my-password" | tw account delegate --chain polygon --profile agent --password-stdin --env prod
```

#### `account export`

```bash
tw account export --profile agent --json --env prod
tw account export --profile agent --show-private --env prod
```

`--show-private` prints the root and session private keys only after you type `EXPORT PRIVATE KEYS` at an interactive terminal. `TW_PASSWORD` and `--password-stdin` unlock the keystore. They do not skip that phrase. MCP and any non-TTY caller are refused.

#### `account change-password`

```bash
tw account change-password --profile agent --env prod
printf "old\nnew\n" | tw account change-password --current-password-stdin --new-password-stdin --json --env prod
```

### Address

`tw address` is the top-level funding command and supersedes the old `account address` path.

```bash
tw address --env prod
tw address --link --amount 100 --env prod
tw address --qr --amount 100 --env prod
tw address --token 0x... --amount 1 --decimals 18 --link --env prod
```

### Transfers and Quotes

#### `send`

```bash
tw send 1 0x1111111111111111111111111111111111111111 --env prod
tw send 2.5 vitalik.eth --chain base --env prod
tw send 1 0x... --profile agent --session worker-2 --env prod
tw send 1 0x... --chain base --session-file ./worker-1.session.json --env prod
```

`send` asks an interactive terminal to type `SEND USDC` before it talks to the relayer. There is no `--yes` flag. MCP and non-interactive callers cannot confirm it. `--session` and `--session-file` are mutually exclusive. Recipients must be an address or `.eth` ENS name; contact aliases are no longer supported.

#### `swap`

Powered by [relay.link](https://relay.link). An interactive terminal confirms the quote. `--yes` skips that prompt only when stdin and stdout are a TTY. MCP and non-interactive callers cannot pass `yes` to skip it.

```bash
tw swap --from ETH --to USDC --amount 0.1 --chain base --env prod
tw swap --from USDC --to ETH --amount 50 --chain base --yes --env prod
```

#### `bridge`

```bash
tw bridge --token USDC --amount 100 --to-chain polygon --env prod
tw bridge --token ETH --amount 0.5 --to-chain base --recipient 0x... --yes --env prod
```

`--yes` is the same interactive-terminal shortcut as `swap`. It is refused over MCP and when the process is not a TTY.

### Session Keys

Session keys are scoped signers that can act on behalf of your account without exposing the root key.

#### `session create`

```bash
echo "my-password" | tw session create worker-1 --profile agent --password-stdin --json --env prod
echo "my-password" | tw session create worker-2 --profile agent --activate --password-stdin --env prod
tw session create worker-admin --profile agent --full-access --env prod
echo "my-password" | tw session create worker-1 --profile agent --resume --password-stdin --json --env prod
echo "my-password" | tw session create alice --profile agent --agent --password-stdin --env prod
```

`--full-access` is mutually exclusive with `--target`, `--selector`, `--spend-limit`, `--spend-limit-raw`, and `--spend-period`. Creating or rotating a session, or granting a permission, asks an interactive terminal to type `CREATE FULL ACCESS SESSION` (`ROTATE FULL ACCESS SESSION` for `session rotate`) when the request is full access: the flag, target `ANY_TARGET` or the account, selector `ANY_FN_SEL` or an account admin selector, a period shorter than a day, a token other than that chain's USDC, or a spend limit above 10 USDC. MCP and non-interactive callers cannot confirm it. Omitting `--target` and `--selector` allows USDC `transfer` only, with a 10 USDC daily spend, and does not need that phrase. `account create` and `account delegate` install `ANY_TARGET`, `ANY_FN_SEL`, and unlimited USDC, and they require the same phrase.

#### `session list` / `session rotate` / `session revoke`

```bash
tw session list --profile agent --json --env prod
tw session list --profile agent --on-chain --json --env prod
echo "my-password" | tw session rotate --profile agent --password-stdin --json --env prod
echo "my-password" | tw session rotate --profile agent --new-name worker-3 --password-stdin --env prod
echo "my-password" | tw session rotate --profile agent --resume --password-stdin --json --env prod
echo "my-password" | tw session revoke worker-1 --profile agent --password-stdin --json --env prod
echo "my-password" | tw session revoke worker-2 --profile agent --force --password-stdin --env prod
echo "my-password" | tw session revoke worker-2 --profile agent --resume --password-stdin --json --env prod
```

Agent sessions require `--force` and clean up local channel bindings as part of revocation.

#### `session export` / `session import`

```bash
TW_PASSWORD="my-password" TW_EXPORT_PASSWORD="export-password" \
  tw session export worker-1 --profile agent --output ./worker-1.session.json --env prod

echo "export-password" | tw session export worker-1 --profile agent \
  --output ./worker-1.session.json --export-password-stdin --env prod

tw session import ./worker-1.session.json --profile worker-1 --env prod
```

Session export writes the session private key into the output file. It requires an interactive terminal and the phrase `EXPORT PRIVATE KEYS`. `TW_PASSWORD` and `TW_EXPORT_PASSWORD` do not skip that phrase, and MCP cannot confirm it.

Session-only profiles can execute `tw send` but cannot run root-keystore management commands.

### Daemon

The daemon holds decrypted session keys in memory so automated workflows can sign without re-entering passwords.

```bash
tw daemon start --json
tw daemon start --foreground --json
echo "my-password" | tw daemon unlock worker-1 --profile agent --password-stdin --duration 15m --json --env prod
tw daemon lock worker-1 --json
tw daemon status --json
tw daemon stop --json
```

`tw daemon start` is idempotent. Key material stays in daemon memory only; encrypted files remain unchanged. The socket does not return raw session keys. `getSessionSecrets` is refused. `sign` and `signMessage` still run against keys that were unlocked.

### Permissions

Fine-grained on-chain permission rules for session keys.

```bash
tw permissions list --profile agent --json --env prod
tw permissions show agent-key --profile agent --json --env prod
tw permissions show --key-hash 0xaaa... --profile agent --json --env prod
echo "my-password" | tw permissions grant agent-key --type call --target any --selector any --profile agent --password-stdin --json --env prod
echo "my-password" | tw permissions grant agent-key --type spend --token USDC --spend-limit 100 --period day --profile agent --password-stdin --json --env prod
echo "my-password" | tw permissions revoke agent-key --rule call:0x...:0xa9059cbb --profile agent --password-stdin --json --env prod
echo "my-password" | tw permissions revoke agent-key --all --profile agent --password-stdin --json --env prod
```

Use `--spend-limit-raw` for base units instead of human amounts.

### Escrow

USDC escrow: lock funds as buyer with a seller and oracle; settle (oracle signs) or refund after deadline.

```bash
tw escrow create 50 0x1111111111111111111111111111111111111111 \
  --oracle 0x2222222222222222222222222222222222222222 --deadline 24h --env prod
tw escrow create 100 0x... --oracle 0x... --deadline 2d --chain base --env prod --json
tw escrow status 0x<64 hex chars> --env prod
tw escrow status 0x... --chain base --json --env prod
TW_ORACLE_PRIVATE_KEY=0x... tw escrow settle 0x<escrowId> \
  --settlement-id 0x<orderId> --oracle 0x2222... --profile agent --env prod
tw escrow settle 0x<escrowId> --settlement-id 0x... --oracle 0x... --signature 0x... --profile agent --env prod
tw escrow refund 0x<escrowId> --profile agent --env prod
tw escrow refund 0x<escrowId> --env prod --json
```

`escrow create` and `escrow refund` move USDC and require an interactive terminal to type `SEND USDC`. `escrow create` requires `--oracle` and `--deadline`. Deadlines accept relative values like `1h`, `2d`, `30m`, `1w` or unix timestamps. Escrow flows support `--session-file` like `tw send`.

Signing with the oracle private key (`--oracle-private-key` or `TW_ORACLE_PRIVATE_KEY`) requires an interactive terminal and the phrase `SIGN ESCROW SETTLEMENT`. MCP does not accept a raw oracle private key. A pre-signed `--signature` does not use the key and does not ask for that phrase. `account passkey` likewise refuses a raw private key over MCP; run it in a terminal and type `AUTHORIZE PASSKEY`.

## Agent & Automation Integration

Every command supports `--json` for machine-readable output. Treat JSON output schemas as the stable contract.

```bash
tw <command> --env prod --json
```

### Password Automation

`TW_PASSWORD` supplies the keystore password. It does not confirm `send`, private-key export, session export, full-access session create or rotate, a wildcard or admin permission grant, passkey authorization, escrow create or refund, or oracle-key escrow settle. A local shell with a pseudo-terminal can type the public phrase. That is a person at this terminal, not a guarantee against a local process. `tw --mcp` still refuses.

Use `TW_PASSWORD` to skip the password prompt:

```bash
TW_PASSWORD="my-password" tw session list --profile agent --json --env prod
```

Or pipe via stdin for commands that accept `--password-stdin`:

```bash
echo "my-password" | tw session rotate --profile agent --password-stdin --json --env prod
```

### Discovery

```bash
tw --help              # All commands
tw send --help         # Command-specific help
tw --llms              # Machine-readable command manifest
tw --mcp               # Run as MCP server (tool ids below)
tw --version           # Version
```

`tw --mcp` registers one tool per leaf command. The ids are `account_balance`, `account_nonce`, `account_history`, `account_status`, `account_create`, `account_delegate`, `account_passkey`, `account_export`, `account_change-password`, `session_create`, `session_export`, `session_import`, `session_list`, `session_rotate`, `session_revoke`, `daemon_start`, `daemon_stop`, `daemon_unlock`, `daemon_lock`, `daemon_status`, `permissions_list`, `permissions_show`, `permissions_grant`, `permissions_revoke`, `escrow_create`, `escrow_status`, `escrow_settle`, `escrow_refund`, `send`, `swap`, `bridge`, `address`, `login`, `logout`.

These calls are refused over MCP, with a message to run the command in a terminal: `account_create` and `account_delegate` (they install a wildcard unlimited session); `send`; `escrow_create` and `escrow_refund`; `account_export` with `showPrivate`; `session_export`; `swap` and `bridge` (including `yes: true`); `session_create`, `session_rotate`, and `permissions_grant` when they install full access (the flag, `ANY_TARGET`, the account, `ANY_FN_SEL`, an account admin selector, a period shorter than a day, a non-USDC token, or a spend above 10 USDC); `account_passkey` when a `privateKey` is supplied; `escrow_settle` when an `oraclePrivateKey` is supplied or `TW_ORACLE_PRIVATE_KEY` would sign. A prompt-injected tool call cannot type the confirmation phrase. On an interactive terminal, `swap` and `bridge` `--yes` still skips the on-screen quote. The daemon socket does not return raw session keys.
