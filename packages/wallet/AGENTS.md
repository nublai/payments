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
    session-daemon-client.ts # Daemon IPC client (ping, loadKey, list, sign, remove)
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

Session key defaults for send-compatible setup should include:

- call wildcard selector `0x32323232` (all function selectors)
- spend permission for transfer token on target chain

`0xe0e0e0e0` is empty calldata selector, not wildcard selector.

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
