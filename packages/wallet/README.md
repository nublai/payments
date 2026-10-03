# tw — Towns Wallet CLI

Your keys. Your account. No signup. No login. Just run it.

`tw` is a local-first CLI for managing smart accounts, session keys, and on-chain permissions on Towns Protocol. It works for humans at the terminal and for agents over `--json` or `--mcp`.

```bash
bunx @towns-labs/wallet --help
```

---

## Quick Start

Create an account and send USDC in under a minute:

```bash
# 1. Create a local account (interactive password prompt)
tw account create --profile main

# 2. Fund it
tw address --qr --amount 100

# 3. Send USDC
tw send 10 vitalik.eth
```

No custody service. No API key. Everything runs locally with encrypted keystores.

---

## How It Works

`tw` manages a local keystore that holds your root key and session keys. Your root key creates and controls your on-chain smart account. Session keys are scoped signers — they can send transactions through the Towns relayer without exposing your root key.

```text
~/.config/towns/tw/profiles/<env>/<profile>/default.keystore.json
~/.config/towns/tw/profiles/<env>/<profile>/sessions/<session-name>.json
```

For agents, the session daemon keeps decrypted keys in memory for a bounded duration so automated workflows can sign without prompting for a password on every call.

---

## Commands

### Root Command Surface

```text
tw address
tw bridge
tw chat <connect|init|list|listen|post>
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
tw account create --profile agent
tw account create --resume --profile agent
echo "my-password" | tw account create --password-stdin --json
tw account create --keystore-path ~/.config/towns/tw/profiles/prod/team/default.keystore.json
```

#### `account status` / `account balance` / `account nonce` / `account history`

```bash
tw account status --profile agent --json
tw account balance --profile agent
tw account balance --profile agent --chain polygon
tw account nonce --profile agent
tw account history --profile agent
tw account history --address 0x... --limit 10 --offset 20
tw account history --chain base,polygon --json
```

`--limit` defaults to 20 (max 100). `offset + limit` must be <= 1000.

#### `account delegate`

```bash
echo "my-password" | tw account delegate --chain polygon --profile agent --password-stdin
```

#### `account export`

```bash
tw account export --profile agent --json
tw account export --profile agent --show-private
```

#### `account change-password`

```bash
tw account change-password --profile agent
printf "old\nnew\n" | tw account change-password --current-password-stdin --new-password-stdin --json
```

### Address

`tw address` is the top-level funding command and supersedes the old `account address` path.

```bash
tw address
tw address --link --amount 100
tw address --qr --amount 100
tw address --token 0x... --amount 1 --decimals 18 --link
```

### Transfers and Quotes

#### `send`

```bash
tw send 1 0x1111111111111111111111111111111111111111
tw send 2.5 vitalik.eth --chain base
tw send 1 0x... --profile agent --session worker-2
tw send 1 0x... --chain base --session-file ./worker-1.session.json
```

`--session` and `--session-file` are mutually exclusive. Recipients must be an address or `.eth` ENS name; contact aliases are no longer supported.

#### `swap`

Powered by [relay.link](https://relay.link). Interactive confirmation by default.

```bash
tw swap --from ETH --to USDC --amount 0.1 --chain base
tw swap --from USDC --to ETH --amount 50 --chain base --yes --json
```

#### `bridge`

```bash
tw bridge --token USDC --amount 100 --to-chain polygon
tw bridge --token ETH --amount 0.5 --to-chain base --recipient 0x... --yes --json
```

### Session Keys

Session keys are scoped signers that can act on behalf of your account without exposing the root key.

#### `session create`

```bash
echo "my-password" | tw session create worker-1 --profile agent --password-stdin --json
echo "my-password" | tw session create worker-2 --profile agent --activate --password-stdin
echo "my-password" | tw session create worker-admin --profile agent --full-access --password-stdin
echo "my-password" | tw session create worker-1 --profile agent --resume --password-stdin --json
echo "my-password" | tw session create alice --profile agent --agent --password-stdin
```

`--full-access` is mutually exclusive with `--target`, `--selector`, `--spend-limit`, `--spend-limit-raw`, and `--spend-period`. Omitting both `--target` and `--selector` uses wildcard call permissions by default.

#### `session list` / `session rotate` / `session revoke`

```bash
tw session list --profile agent --json
tw session list --profile agent --on-chain --json
echo "my-password" | tw session rotate --profile agent --password-stdin --json
echo "my-password" | tw session rotate --profile agent --new-name worker-3 --password-stdin
echo "my-password" | tw session rotate --profile agent --resume --password-stdin --json
echo "my-password" | tw session revoke worker-1 --profile agent --password-stdin --json
echo "my-password" | tw session revoke worker-2 --profile agent --force --password-stdin
echo "my-password" | tw session revoke worker-2 --profile agent --resume --password-stdin --json
```

Agent sessions require `--force` and clean up local channel bindings as part of revocation.

#### `session export` / `session import`

```bash
TW_PASSWORD="my-password" TW_EXPORT_PASSWORD="export-password" \
  tw session export worker-1 --profile agent --output ./worker-1.session.json

echo "export-password" | tw session export worker-1 --profile agent \
  --output ./worker-1.session.json --export-password-stdin

tw session import ./worker-1.session.json --profile worker-1
```

Session-only profiles can execute `tw send` but cannot run root-keystore management commands.

### Daemon

The daemon holds decrypted session keys in memory so automated workflows can sign without re-entering passwords.

```bash
tw daemon start --json
tw daemon start --foreground --json
echo "my-password" | tw daemon unlock worker-1 --profile agent --password-stdin --duration 15m --json
tw daemon lock worker-1 --json
tw daemon status --json
tw daemon stop --json
```

`tw daemon start` is idempotent. Key material stays in daemon memory only; encrypted files remain unchanged.

### Permissions

Fine-grained on-chain permission rules for session keys.

```bash
tw permissions list --profile agent --json
tw permissions show agent-key --profile agent --json
tw permissions show --key-hash 0xaaa... --profile agent --json
echo "my-password" | tw permissions grant agent-key --type call --target any --selector any --profile agent --password-stdin --json
echo "my-password" | tw permissions grant agent-key --type spend --token USDC --spend-limit 100 --period day --profile agent --password-stdin --json
echo "my-password" | tw permissions revoke agent-key --rule call:0x...:0xa9059cbb --profile agent --password-stdin --json
echo "my-password" | tw permissions revoke agent-key --all --profile agent --password-stdin --json
```

Use `--spend-limit-raw` for base units instead of human amounts.

### Escrow

USDC escrow: lock funds as buyer with a seller and oracle; settle (oracle signs) or refund after deadline.

```bash
tw escrow create 50 0x1111111111111111111111111111111111111111 \
  --oracle 0x2222222222222222222222222222222222222222 --deadline 24h
tw escrow create 100 0x... --oracle 0x... --deadline 2d --chain base --env prod --json
tw escrow status 0x<64 hex chars> --env prod
tw escrow status 0x... --chain base --json
TW_ORACLE_PRIVATE_KEY=0x... tw escrow settle 0x<escrowId> \
  --settlement-id 0x<orderId> --oracle 0x2222... --profile agent
tw escrow settle 0x<escrowId> --settlement-id 0x... --oracle 0x... --signature 0x... --profile agent
tw escrow refund 0x<escrowId> --profile agent
tw escrow refund 0x<escrowId> --env prod --json
```

`escrow create` requires `--oracle` and `--deadline`. Deadlines accept relative values like `1h`, `2d`, `30m`, `1w` or unix timestamps. Escrow flows support `--session-file` like `tw send`.

### Chat

Chat identities are session-key-backed Towns identities with their own encryption device and named channel bindings.

```text
~/.config/towns/tw/profiles/<env>/<profile>/sessions/<name>.json
~/.config/towns/tw/profiles/<env>/<profile>/agent-channels.json
```

#### `session create --agent` / `chat init` / `session list`

```bash
TW_PASSWORD="my-password" tw session create alice --profile agent --agent
TW_PASSWORD="my-password" tw session create bob --profile agent
TW_PASSWORD="my-password" tw chat init bob --profile agent
TW_PASSWORD="my-password" tw session list --profile agent --json
```

`tw session list` includes a `kind` field (`session` or `agent`). Revoke chat identities with `tw session revoke <name> --force`.

Migration note: legacy `agent-<name>.json` files are no longer loaded. Rename them to `<name>.json` manually or recreate them with `tw session create` plus `tw chat init`.

#### `chat connect`

```bash
TW_PASSWORD="my-password" tw chat connect --from alice --channel art --to bob --profile agent
TW_PASSWORD="my-password" tw chat connect --from bob --channel art --secret "<shared-secret>" --to alice --profile agent
```

#### `chat post`

```bash
TW_PASSWORD="my-password" tw chat post --from alice --channel art "hello from alice" --profile agent
TW_PASSWORD="my-password" tw chat post --from alice 77aaa... "debug message" --profile agent
```

#### `chat listen`

```bash
TW_PASSWORD="my-password" tw chat listen --from bob --channel art --profile agent
TW_PASSWORD="my-password" tw chat listen --from bob --stream 77aaa... --profile agent
```

Messages arrive as NDJSON:

```json
{
  "type": "message",
  "streamId": "77...",
  "senderId": "0x...",
  "eventId": "0x...",
  "timestamp": 1709654400,
  "content": "hello from alice"
}
```

#### `chat list`

```bash
TW_PASSWORD="my-password" tw chat list --from alice --profile agent --json
```

#### Chat Quickstart

```bash
# Create profile + two chat sessions
tw account create --profile agent
TW_PASSWORD="pw" tw session create alice --profile agent --agent
TW_PASSWORD="pw" tw session create bob --profile agent
TW_PASSWORD="pw" tw chat init bob --profile agent

# Alice creates a channel -> copy the returned secret
TW_PASSWORD="pw" tw chat connect --from alice --channel art --to bob --profile agent

# Bob binds with that secret
TW_PASSWORD="pw" tw chat connect --from bob --channel art --secret "<secret>" --to alice --profile agent

# Terminal 1: listen
TW_PASSWORD="pw" tw chat listen --from bob --channel art --profile agent

# Terminal 2: send
TW_PASSWORD="pw" tw chat post --from alice --channel art "hello" --profile agent
```

Smoke test:

```bash
cd packages/wallet
TW_PASSWORD="my-password" bun run smoke:chat
```

---

## Agent & Automation Integration

Every command supports `--json` for machine-readable output. Treat JSON output schemas as the stable contract.

```bash
tw <command> --json
```

### Password Automation

Use `TW_PASSWORD` to skip interactive prompts:

```bash
TW_PASSWORD="my-password" tw session list --profile agent --json
```

Or pipe via stdin for commands that accept `--password-stdin`:

```bash
echo "my-password" | tw session rotate --profile agent --password-stdin --json
```

### Discovery

```bash
tw --help              # All commands
tw send --help         # Command-specific help
tw --llms              # Machine-readable command manifest
tw --mcp               # Run as MCP server
tw --version           # Version
```
