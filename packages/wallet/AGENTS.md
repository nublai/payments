# AGENTS.md

This file provides package-local guidance for coding agents working in `packages/wallet`.

It augments (does not replace) root-level guidance in `AGENTS.md` (repository root).

## Overview

`wallet-cli` (`tw`) is the command-line interface for relayer account workflows:

- create and manage local keystore material
- inspect account metadata/address/balance
- execute USDC sends through relayer flows
- swap tokens and bridge across chains via relay.link
- manage session keys and on-chain permissions
- USDC escrow: create, status, settle, and refund via relayer

Built on the [incur](https://github.com/wevm/incur) CLI framework — all commands are declarative Zod-schema-based definitions with automatic `--help`, `--json`, `--format`, `--llms` manifest, and `--mcp` server mode.

## Directory Layout

```
src/
  cli.ts                    # Entry point — all command definitions (incur Cli)
  cli-runtime.ts            # CLI-only runtime helpers (log suppression, handle dumps)
  lib/
    account-address.ts      # executeAccountAddress
    account-balance.ts      # executeAccountBalance
    account-create.ts       # executeAccountCreate + resolveKeystorePath + password helpers
    account-delegate.ts     # executeAccountDelegate
    account-export.ts       # executeAccountExport
    account-nonce.ts        # executeAccountNonce
    account-send.ts         # executeAccountSend
    account-status.ts       # executeAccountStatus (readiness diagnostics)
    account-swap.ts         # executeAccountSwap (swap/bridge via relay.link)
    account-update-password.ts  # executeAccountUpdatePassword
    agent-channel-registry.ts   # Shared named-channel rendezvous registry
    address.ts              # executeAddress (funding address + QR/link)
    session-create.ts       # executeSessionCreate
    session-daemon.ts       # Session daemon server (runSessionDaemon, runSessionDaemonEntry)
    session-daemon-client.ts # Daemon IPC client (ping, loadKey, list, sign, remove). getSessionSecrets is refused.
    session-daemon-paths.ts # Daemon state dir, pid file, socket path resolution
    session-daemon-protocol.ts # Daemon JSON protocol (parse/serialize, error codes)
    session-list.ts         # executeSessionList
    session-lock.ts         # executeSessionLock
    session-revoke.ts       # executeSessionRevoke
    session-rotate.ts       # executeSessionRotate
    session-start.ts        # executeSessionStart (foreground + spawn)
    session-status.ts       # executeSessionStatus
    session-stop.ts         # executeSessionStop
    session-unlock.ts       # executeSessionUnlock
    permissions-grant.ts    # executePermissionsGrant
    permissions-list.ts     # executePermissionsList
    permissions-revoke.ts   # executePermissionsRevoke
    permissions-show.ts     # executePermissionsShow
    escrow-common.ts        # EscrowError, parseEscrowId, resolveEscrowContracts, toEscrowError
    escrow-create.ts        # executeEscrowCreate
    escrow-execute.ts       # executeEscrowCallsWithFallback, loadEscrowSessionAndSender
    escrow-refund.ts        # executeEscrowRefund
    escrow-settle.ts        # executeEscrowSettle
    escrow-status.ts        # executeEscrowStatus
    delegation-utils.ts     # hasDelegationCode, DELEGATION_CODE_PREFIX
    execute-calls.ts        # Low-level relayer call execution
    keystore.ts             # Keystore read/write/encryption
    network-config.ts       # Chain configs, env defaults, RPC URLs, token resolution
    nonce-utils.ts          # On-chain nonce reading
    password-readline.ts    # Interactive password prompts (@clack/prompts)
    permissions-common.ts   # Shared permission parsing helpers
    relay-link.ts           # relay.link API client (quotes, intent status, polling)
    relayer-client-utils.ts # Relayer HTTP client wrappers
    session-common.ts       # Shared session/permission parsing and defaults
    type-guards.ts          # Shared type guard utilities (isRecord)
tests/
  *-flow.test.ts            # Flow tests for each command group
  escrow-common.test.ts     # Unit tests for escrow ID/contract resolution, toEscrowError
  escrow-status-flow.test.ts # Escrow status flow tests
  agent-*.test.ts           # Agent flow coverage (init/connect/send/listen/channels)
  session-common.test.ts    # Unit tests for pure session helpers
  session-daemon.test.ts    # Daemon lifecycle (load/list/sign/expiry)
  session-daemon-client.test.ts # Client id mismatch, malformed response
  session-daemon-protocol.test.ts # Protocol parse/serialize, invalid payloads
  session-start.test.ts    # resolveDaemonEntrypoint (built vs dev)
  session-stop.test.ts      # Stop behavior (no unlink when process does not exit)
  signer.test.ts            # resolveSessionSigner (daemon vs direct, errors)
  delegation-utils.test.ts  # Unit tests for delegation code inspection
  keystore.test.ts          # Keystore encryption/decryption tests
  network-config.test.ts    # Chain/env resolution tests
  relay-link.test.ts        # relay.link client unit tests
```

## Commands

Run these from `packages/wallet`:

```bash
# tests
bun run test

# typecheck
bunx tsc --noEmit

# build
bun run build

# focused test
bun test tests/account-send-flow.test.ts

# dev mode (runs src/cli.ts directly via bun)
bun run dev

# prettier
bun run fmt
bun run fmt:check
```

## Architecture

### Two-layer design

1. **`src/cli.ts`** — Command definitions (incur layer)
   - Declares Zod schemas for args, options, env, and output
   - Wires password resolution (env var, stdin, readline prompts)
   - Calls the corresponding `execute*` function and returns the result
   - Does NOT contain business logic

2. **`src/lib/*.ts`** — Business logic (`execute*` functions)
   - Each command has one `execute*` function that takes typed options and returns a typed result
   - Pure business logic: reads keystore, talks to relayer/RPC, returns structured data
   - All side effects (network, filesystem) are injected via a `depsArg?: Partial<*Deps>` parameter
   - incur handles output formatting (JSON, text, table) — lib functions never write to stdout

### Dependency injection pattern

Every `execute*` function accepts an optional `depsArg` for testing:

```typescript
type AccountNonceDeps = {
    executeAccountAddress: (...) => Promise<...>
    readNonce: (...) => Promise<bigint>
}

export async function executeAccountNonce(
    options: AccountNonceOptions,
    depsArg?: Partial<AccountNonceDeps>,
): Promise<AccountNonceResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    // ... use deps.readNonce(), deps.executeAccountAddress(), etc.
}
```

Tests mock the deps to avoid real network/filesystem calls:

```typescript
const result = await executeAccountNonce(
  { env: "prod", keystorePath: "/tmp/alice.json", chain: "base" },
  {
    executeAccountAddress: mock(async () => ({
      type: "account_address",
      status: "complete",
      keystorePath: "/tmp/alice.json",
      address: "0x1111111111111111111111111111111111111111",
    })),
    readNonce: mock(async () => 123n),
  },
);
```

## How to Add a New Command

### Step 1: Create the lib file

Create `src/lib/<command-name>.ts` with this structure:

```typescript
// 1. Define error codes
type MyCommandErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'UNKNOWN'

// 2. Create typed error class
export class MyCommandError extends Error {
    code: MyCommandErrorCode
    cause?: unknown
    constructor(code: MyCommandErrorCode, message: string, options?: { cause?: unknown }) {
        super(message)
        this.name = 'MyCommandError'
        this.code = code
        this.cause = options?.cause
    }
}

// 3. Define options and result types
export type MyCommandOptions = {
    env: EnvName
    keystorePath?: string
    name?: string
    // ... command-specific options
}

export type MyCommandResult = {
    type: 'my_command'
    status: 'complete'
    // ... command-specific output fields
}

// 4. Define deps interface for testability
type MyCommandDeps = {
    readSomething: (input: { ... }) => Promise<...>
}

// 5. Default deps (real implementations)
function getDefaultDeps(): MyCommandDeps {
    return {
        readSomething: async (input) => { /* real implementation */ },
    }
}

// 6. Main execute function with dep injection
export async function executeMyCommand(
    options: MyCommandOptions,
    depsArg?: Partial<MyCommandDeps>,
): Promise<MyCommandResult> {
    const deps = { ...getDefaultDeps(), ...depsArg }
    // ... business logic using deps
    return { type: 'my_command', status: 'complete', /* ... */ }
}
```

### Step 2: Register the command in cli.ts

Add the command to the appropriate group in `src/cli.ts`:

```typescript
// For account.command(), session.command(), or permissions.command()
account.command("my-command", {
  description: "Short description of what this command does",
  args: z.object({
    // positional args (optional)
    target: z.string().describe("..."),
  }),
  options: z.object({
    // named options
    env: envSchema,
    profile: profileSchema,
    keystorePath: keystorePathSchema,
    chain: chainSchema,
    // command-specific options...
  }),
  env: passwordEnv, // only if command needs password
  output: z.object({
    // output schema for --json/--llms
    type: z.string(),
    status: z.string(),
    // ... must match MyCommandResult shape
  }),
  examples: [{ options: { env: "dev" }, description: "Example usage" }],
  async run({ args, options, env }) {
    // Wire password if needed
    // Call executeMyCommand(...)
    // Return the result (incur formats it)
  },
});
```

### Step 3: Write tests

Create `tests/<command-name>-flow.test.ts`:

```typescript
import { expect, mock, test } from "bun:test";
import { executeMyCommand } from "../src/lib/my-command";

test("executeMyCommand returns expected result", async () => {
  const result = await executeMyCommand(
    { env: "prod", keystorePath: "/tmp/alice.json" },
    {
      readSomething: mock(async () => "value"),
    },
  );
  expect(result.type).toBe("my_command");
  expect(result.status).toBe("complete");
});

test("executeMyCommand handles errors", async () => {
  await expect(
    executeMyCommand(
      { env: "prod", keystorePath: "/tmp/alice.json" },
      {
        readSomething: mock(async () => {
          throw new Error("network");
        }),
      },
    ),
  ).rejects.toMatchObject({ code: "UNKNOWN" });
});
```

### Step 4: Add to a new command group (if needed)

To create a new top-level command group:

```typescript
// In cli.ts
const myGroup = Cli.create('my-group', {
    description: 'My group of commands',
})

myGroup.command('sub-command', { ... })

// Mount on root
tw.command(myGroup)
```

## Current Command Surface

- Root commands:
  - `tw address` — funding address with optional QR/link
  - `tw bridge`
  - `tw daemon ...`
  - `tw account ...`
  - `tw login`
  - `tw logout`
  - `tw permissions ...`
  - `tw send`
  - `tw session ...`
  - `tw swap`
  - `tw escrow ...`
  - `tw --version`
  - `tw --help`
  - `tw --llms` (incur auto-generated manifest)
  - `tw --mcp` (incur MCP server mode)
- Account subcommands:
  - `create`, `delegate`, `balance`, `nonce`, `history`, `status`, `export`, `change-password`, `passkey`
- Session subcommands:
  - `create`, `list`, `rotate`, `revoke`, `export`, `import`
- Daemon subcommands:
  - `start`, `stop`, `status`, `unlock`, `lock`
- Permissions subcommands:
  - `list`, `show`, `grant`, `revoke`
- Escrow subcommands:
  - `create` — create USDC escrow (buyer locks funds; seller, oracle, deadline)
  - `status` — check on-chain escrow status by escrow ID (32-byte hex)
  - `settle` — submit oracle settlement signature to release funds to seller
  - `refund` — permissionless refund to buyer after deadline

## Environment and Keystore Defaults

- Supported environments: `prod`, `stage`, `dev`
- `prod` is the default unless overridden
- `dev` defaults:
  - relayer URL: local worker (`127.0.0.1:8787`)
  - RPC: local anvil (`127.0.0.1:8545`)
  - chain: `anvil`
- Profile and keystore resolution follows `account-create` conventions in `src/lib/account-create.ts`

## Password Handling

Commands that need keystore decryption accept passwords through three channels (in priority order):

1. `--password-stdin` — read from stdin pipe
2. `TW_PASSWORD` env var — declared via incur's `env` schema
3. Interactive prompt via `@clack/prompts` — writes to stderr (incur controls stdout)

The `passwordDeps()` helper in `cli.ts` wires all three. The `password-readline.ts` module provides the interactive prompts (password input with masking, new-password with confirmation).

`TW_PASSWORD` is not a confirmation. These operations require a phrase typed on an interactive terminal (`stdin` and `stdout` both TTYs). `tw --mcp` and any non-TTY `tw` are refused before keys are printed, RPC is contacted, or a signature is produced. A local pseudo-terminal can type the phrase; that is a human at this terminal, not a defense against a local shell. `--mcp` still refuses when the server itself is attached to a PTY.

- `account export --show-private` and `session export` — type `EXPORT PRIVATE KEYS`. `TW_EXPORT_PASSWORD` does not skip it
- `send`, `escrow create`, and `escrow refund` — type `SEND USDC`. Create and refund move USDC
- `swap` and `bridge` — confirm the quote in the terminal. `--yes` / `yes: true` is ignored outside that terminal. On a TTY, `--yes` does not skip the call-target review: every target, selector, approve spender and amount, and native value is shown, and the human still confirms. `--yes` only skips refreshing a quote that went stale during that confirmation. Calls must match the relay.link allowlist in `src/lib/relay-allowlist.ts` (Base 8453 and Polygon 137). Chain 31337 is fail-closed. No flag or env var skips the allowlist. A local pseudo-terminal can still answer the confirm prompt
- `account create` and `account delegate` — type `CREATE FULL ACCESS SESSION`. The session they install is narrow: this chain's USDC `transfer` (`0xa9059cbb`) and `approve` (`0x095ea7b3`), Escrow `escrow` (`0x657061bf`) and `refund` (`0x6023fda5`), SimpleSettler `write` (`0x84523a30`), and Escrow `settle` (`0xe7f921a2`), plus 10 USDC per day. `write` and `settle` are included because `tw escrow settle` submits both from this session. A chain with no known USDC or Escrow address fails closed. The phrase stays; MCP cannot type it
- `session create` / `session rotate` / `permissions grant` when the result is full access — type `CREATE FULL ACCESS SESSION` or `ROTATE FULL ACCESS SESSION` for rotate. Full access is the `--full-access` flag, target `ANY_TARGET` or the account, selector `ANY_FN_SEL`, `increaseAllowance` (`0x39509351`), or an account admin selector (`authorize`, `revoke`, `setCanExecute`, `setSpendLimit`, `upgradeProxyAccount`), a spend period shorter than a day (`minute`, `hour`), a token other than that chain's USDC, a spend limit above the default 10 USDC, or a combined USDC spend across the account's active sessions on that chain that would exceed 10 USDC per day. A forever or longer-period cap counts at its full limit. If those keys cannot be read, the phrase is required. A day-or-longer USDC limit of exactly 10 stays allowed, including when the amount is omitted on `session create`, until the combined total would pass 10
- `daemon unlock` when the session holds a wildcard, an unlimited or max-uint spend, anything else above that gate, or permissions that cannot be read — type `UNLOCK FULL ACCESS SESSION` before the password. A narrow session unlocks with the password alone. MCP cannot type the phrase
- `session rotate --narrow` — type `ROTATE FULL ACCESS SESSION`. Replaces the active session with the narrow default and revokes the old key. `session revoke` of a full-access or unreadable session — type `REVOKE FULL ACCESS SESSION` before the password
- `swap` and `bridge` need an explicit full-access session. The error tells you to run `tw session create <name> --full-access` and type `CREATE FULL ACCESS SESSION`
- `account passkey` — type `AUTHORIZE PASSKEY`. The `privateKey` argument is not accepted over MCP
- `escrow settle` when signing with an oracle private key — type `SIGN ESCROW SETTLEMENT`. The `oraclePrivateKey` argument is not accepted over MCP

A session created without those elevated permissions keeps USDC `transfer` and a 10 USDC daily spend, and does not need the full-access phrase. Existing accounts keep a legacy wildcard plus max-uint session until `tw session rotate --narrow` or `tw session revoke`. `account status` warns when that wildcard is present: the key holds full access, and the daemon can spend it once unlocked. The daemon socket does not return raw session keys (`getSessionSecrets` is refused). `sign` and `signMessage` stay on the socket. Metadata export and escrow status do not spend. Local `e2e:local-payment` and `e2e:local-escrow` type `CREATE FULL ACCESS SESSION` for `account create`, `SEND USDC` for send and escrow create, and `SIGN ESCROW SETTLEMENT` for settle, through `scripts/tw-tty-confirm.py`, because those scripts are the operator, not an MCP client. `e2e:local-payment` exports the local deployment addresses so account create can resolve Escrow on chain 31337.

## Critical Gotchas

### 1) `send` signature format

Session-key execution must submit a wrapped signature, not raw typed-data signature.

Use relayer-client helpers:

- `encodeSecp256k1Key`
- `computeKeyHash`
- `wrapSignature`

### 2) `prepareCalls` context

For reliable send behavior, include:

- explicit `nonce` (read from account `getNonce(0)`)
- `sessionKey` in prepare request

### 3) Status interpretation

A mined transaction does not always mean successful intent execution.

Always treat bundle status as source of truth:

- `200/201`: success path
- `400/500`: intent-level revert/failure
- inspect `intent_error` via `wallet_getCallsStatus`

### 4) Session permissions for transfer flows

The default session for send and escrow is narrow:

- USDC `transfer` (`0xa9059cbb`) and `approve` (`0x095ea7b3`)
- Escrow `escrow` (`0x657061bf`), `refund` (`0x6023fda5`), and `settle` (`0xe7f921a2`)
- SimpleSettler `write` (`0x84523a30`)
- 10 USDC per day

Swap and bridge need `tw session create <name> --full-access`. `0xe0e0e0e0` is empty calldata selector, not wildcard selector. A legacy wildcard session is full access; `account status` warns, and `tw session rotate --narrow` replaces it.

### 5) Local chain restarts

After anvil reset, on-chain delegation/permissions are gone even if local keystore exists.

Recreate/delegate/fund again in local dev before validating send flows.

## Testing Expectations

- Use TDD for non-trivial behavior changes.
- All `execute*` functions should be testable via dep injection — no real network calls in unit tests.
- Prefer flow tests for externally observable behavior:
  - output shape (typed result objects)
  - typed error codes
  - env/chain default behavior
- Test naming convention: `tests/<feature>-flow.test.ts` for command flows, `tests/<module>.test.ts` for pure unit tests.
- Update tests when command contracts change.

## Documentation and References

- Package usage docs:
  - `packages/wallet/README.md`
- Next-actions design guidance:
  - `packages/wallet/docs/next-actions-matrix.md`
- Solved issue references:
  - `packages/wallet/docs/solutions/integration-issues/relayer-cli-account-send-simulation-failed-20260219.md`
  - `packages/wallet/docs/solutions/integration-issues/wallet-cli-swap-bridge-feature-flow-and-integration-gotchas-20260306.md`
- Related package guidance (link only):
  - `packages/walletent/AGENTS.md`
  - `packages/relayer/AGENTS.md`

## Change Discipline

- Keep this file lean and operational.
- Prefer stable guidance over implementation trivia.
- If behavior changes, update this file and relevant package docs/tests in the same PR.
