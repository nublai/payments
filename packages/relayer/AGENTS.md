# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Overview

Relayer is a Cloudflare Worker that processes signed blockchain intents and relays them for execution. It abstracts away gas management, nonce handling, and cross-chain complexity—users sign intents describing what they want, and the relayer handles how to execute it.

## Quickstart (Local Dev)

```bash
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

## Commands

```bash
# Development
bun run dev                    # Local dev server on :8787
bun run test                   # Run tests (watch mode)
bun run test:run               # Single test run
bun run test -- <pattern>      # Run specific test file

# Quality
bun run lint                   # oxlint with warnings as errors
bun run lint:fix               # Auto-fix lint issues
bun run format                 # Prettier formatting

# Build & Deploy
bun run build                  # Type check + wrangler build
bun run deploy:stage           # Deploy to stage
bun run deploy:prod            # Deploy to prod
bun run logs:stage             # Tail stage logs
bun run logs:prod              # Tail prod logs
```

## Docs to Read First

- `docs/CRITICAL_PATHS.md`
- `docs/SECURITY_AUDIT.md`
- `docs/ARCHITECTURE.md`
- `packages/relayer-client/AGENTS.md` (integration test mapping for RPC changes)

## Package Relationship

This package is **tightly coupled** with `@agentic-payments/relayer-client` (`packages/relayer-client/`):

| Package                  | Role                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `relayer` (this package) | Backend - Cloudflare Worker exposing JSON-RPC 2.0 endpoints |
| `relayer-client`         | Client SDK - TypeScript library that calls this relayer     |

**Key dependencies:**

- Both packages share identical EIP-712 type definitions for intent signing
- RPC method signatures in `src/rpc/methods/` define the contract that relayer-client consumes
- Changes to request/response schemas here **will break** relayer-client if not synchronized

**When modifying this package, always verify changes against relayer-client integration tests** (see Testing section).

## Cross-Package Interaction Map

**Intent flow (client → relayer → contracts):**

- `relayer-client` calls `wallet_prepareCalls` → relayer builds typed data + quote context.
- `relayer-client` signs EIP-712 `Intent` and calls `wallet_sendPreparedCalls`.
- relayer builds `IntentStruct`, sends to SignerPool DO, and tracks bundle status.
- contracts `Orchestrator.execute` verifies signature + nonce via `Account`, then executes calls.

**Key invariants (must stay in sync):**

- EIP-712 `Intent` types/field order: `relayer/src/services/relayer.ts` ⇄ `relayer-client/src/types.ts` ⇄ `contracts/src/accounts/Orchestrator.sol`.
- Signature wrapping for authorized keys: `relayer-client/src/actions/signIntent.ts` ⇄ `contracts/src/accounts/Account.sol`.
- Nonce model (2D seqKey|seq): `relayer IntentNonceDO` ⇄ `contracts LibNonce` (enforced via `Account.checkAndIncrementNonce`).
- Payment fields (`payer`, `paymentToken`, `paymentMaxAmount`, `paymentAmount`): relayer quotes → client intent → Orchestrator `_pay`.

**Quick file pointers:**

- `relayer/src/rpc/methods/{prepareCalls.ts,sendPreparedCalls.ts,getCallsStatus.ts}` - JSON-RPC handlers for prepare/send/status.
- `relayer/src/services/relayer.ts` - EIP-712 typed data + gas/nonce prep.
- `relayer-client/src/actions/{prepareIntent.ts,signIntent.ts,submitIntent.ts}`
- `relayer-client/src/transport.ts` - JSON-RPC wire format.
- `contracts/src/accounts/Orchestrator.sol` - Intent digest + execution path.
- `contracts/src/accounts/Account.sol` - Signature unwrap + nonce/pay enforcement.

## Architecture

### Entry Points

- `src/index.ts` - Hono app, queue consumer, cron handler
- `src/rpc/dispatcher.ts` - JSON-RPC 2.0 request routing (single and batch)
- `src/rpc/methods/{prepareCalls.ts,sendPreparedCalls.ts,getCallsStatus.ts}` - Core intent methods

### Durable Objects (SQLite-backed)

All persistent state lives in Durable Objects with SQLite storage for atomicity:

| DO               | Purpose                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `SignerDO`       | Individual signer: key derivation, nonce management, tx signing/broadcasting     |
| `SignerPoolDO`   | Stateless coordinator: routes txs to signers, queries capacity, runs maintenance |
| `IntentNonceDO`  | 2D nonce (seqKey:192 \| seq:64) for per-account intent ordering                  |
| `BundleStatusDO` | Maps intent requests to on-chain transaction status                              |

**Schema & migrations**

- SQLite schema/migrations are inline in `src/durable-objects/*.do.ts`
- DO class migrations (`new_sqlite_classes`) live in `wrangler.toml`

### Durable Object Conventions

- Prefer Durable Object RPC method calls (`stub.someMethod(...)`) over internal HTTP (`stub.fetch(...)`) for worker-to-DO communication.
- Public DO methods should expose business actions directly (for example, `consumeNonce`) and `fetch()` should not be the primary internal API path.
- Include units in time variable names (`ttlSeconds`, `nowUnixSeconds`, `alarmAtMs`) to avoid second/millisecond confusion.
- For expiration-based cleanup, prefer scheduling `alarm()` with `ctx.storage.setAlarm(...)` and cleaning on alarm rather than doing global cleanup on every request path.
- Keep replay/validity boundary semantics explicit: equality-at-expiry should be treated consistently in both runtime logic and tests.

### Transaction Flow

1. `wallet_prepareCalls` → validate intent, simulate, calculate fees, return quote hash
2. `wallet_sendPreparedCalls` → route to SignerPoolDO → select best signer by capacity → broadcast
3. Queue monitors tx receipt with exponential backoff → notifies SignerDO on finality

### Key Patterns

- **HD wallet signer pool**: Derives multiple signers from mnemonic via BIP32 path `m/44'/60'/0'/0/{index}`
- **Capacity-based routing**: Each signer tracks pending txs; requests route deterministically by `keccak256(eoa) % signerCount`
- **Atomic nonce management**: SQLite transactions prevent race conditions
- **Intent expiry**: Rejects intents within 30s buffer of expiration

## Configuration

Required secrets (set via `wrangler secret put`):

- `RPC_URL` - JSON-RPC endpoint
- `RELAYER_MNEMONIC` - HD wallet mnemonic
- `CHAIN_ID` - Chain ID (31337=local, 84532=Base Sepolia, 8453=Base)

Contract addresses are auto-loaded from `@agentic-payments/contracts`. See README.md for full configuration options.

## Relayer/Deploy Guardrails

1. **Chain context is required**
   - Client flows should send explicit chain context via prepared quote context.
   - Do not rely on implicit/default chain selection in request handlers.
   - Keep scenario coverage that fails when chain context is missing.

2. **Validate multi-chain balances per chain RPC**
   - `wallet_getCapabilities` balance reads must use each chain's configured RPC URL.
   - Add/keep regression coverage asserting different balances are reflected across chains when funding differs.

3. **Cloudflare DO deploy configuration**
   - For environments using Durable Objects, set `preview_urls = false` in `wrangler.toml` (for example `stage` and `prod`).
   - This avoids Cloudflare deploy error `100331` ("Cannot use Durable Objects with Preview URLs").

4. **Pre-deploy config/secrets consistency check**
   - Before stage/prod deploy, verify:
     - `CHAIN_IDS` includes all supported chains.
     - Every chain in `CHAIN_IDS` has matching `RPC_<chainId>` secret.
     - Runtime code paths/tests contain no stale single-chain assumptions.

## Queues & Cron

- Local dev queue: `relayer-monitor-queue-local`
- Stage/prod queues: `relayer-monitor-queue-stage`, `relayer-monitor-queue-prod`
- Stage/prod cron: `*/5 * * * *` (monitor sweep)

## Testing

### Development Flow

Follow this TDD workflow when making changes:

1. **Write/update unit tests** for the logic you're changing
2. **Build**: `bun run build`
3. **Run unit tests**: `bun run test:run` (must pass before proceeding)
4. **Run integration tests** in relayer-client (see below)

### Unit Tests (this package)

Tests use `@cloudflare/vitest-pool-workers` to run in a Workers-like environment. Test files are in `/test` with patterns for unit, DO, and RPC endpoint tests.

```bash
# Run all unit tests
bun run test:run

# Run specific test
bun run test -- signer.test.ts
bun run test -- rpc/calls
```

### Integration Tests (REQUIRED)

**IMPORTANT:** The canonical integration tests live in `packages/relayer-client/`. You **MUST** run these when modifying:

- RPC methods (`src/rpc/methods/`)
- Signature verification logic
- Nonce management (`IntentNonceDO`, `SignerDO`)
- Transaction broadcasting
- Any request/response schemas

**Services are started automatically** - `test:integration` handles Anvil and relayer startup/cleanup.

```bash
# From packages/relayer-client/
bun run test:integration -- <scenario-filter>  # Run specific scenario
bun run test:integration                        # Run all (before committing)
```

### Integration Test Reference

See **`packages/relayer-client/CLAUDE.md`** for:

- Scenario test mapping (which test to run for your change)
- Full list of available scenarios
- Adding new scenario tests
- Detailed testing workflows

## Account & Signature Gotchas

- **Delegated EOAs have code**: `getCode()` starts with `0xef0100` after EIP-7702 delegation.
- **SignatureCheckerLib behavior**: if signer has code, it calls `isValidSignature()` (ERC-1271 path).
- **SuperAdmin key pitfall**: using the delegated account address as the SuperAdmin key fails because the inner signature is raw ECDSA (not wrapped).
- **Fix**: use a distinct EOA for SuperAdmin signing (separate keypair from the delegated account).
- **Key hash**: `keccak256(abi.encode(uint8(keyType), keccak256(publicKey)))` with `keyType` 0=secp256k1, 1=external.

Contract references: `Account.sol:258-283`, `Account.sol:498-561`, `Account.sol:230-248`.

## Price Oracle Integration Gotchas

- **Workers test runner API differences:** `vi.hoisted`, `vi.stubGlobal`, and `vi.unstubAllGlobals` are not available in the Cloudflare Workers pool. Prefer manual global stubbing and mock `src/lib/viem-utils` instead of mocking `viem` with `importOriginal`.
- **Local chain config:** When using `CHAIN_ID=31337`, fee-token lookups depend on `src/config/chains.json`. Missing 31337 assets cause “Unsupported payment token.” Also `layerZero.endpointId` must be > 0 to satisfy schema validation.
- **Reimbursement test flakiness:** `paymentMaxAmount` can be too low due to fee/price variance. Use a larger buffer or read the relayer-quoted `paymentAmount` via `prepareIntent` before signing.

### Multicall3 Changes msg.sender

Cannot use Multicall3 to batch calls to functions with `onlyOwner` or `msg.sender` checks.

```
Caller → Multicall3.aggregate([targetA.foo(), targetB.bar()])
              ↓
         msg.sender inside foo() and bar() = Multicall3 address, NOT original caller
```

**Example:** `SimpleSettler.write()` has `onlyOwner` modifier. Batching it via Multicall3 fails because `msg.sender` becomes `0xcA11...` (Multicall3), not the relayer wallet.

**Solution:** Make sequential direct calls instead of batching.

### EIP-712 Signature Field Mismatch

All fields in the EIP-712 type definition must be passed through the entire pipeline. Missing a single field (e.g., `settler`) causes the typed data hash to differ, resulting in `VerificationError()`.

When debugging signature issues:

1. Log the exact struct being signed on the client
2. Compare with what the contract reconstructs
3. Check every field, including optional ones that default to zero


## Remote Test Runs (Relayer Client)

Use these when validating relayer flows against a deployed worker/RPC instead of local Anvil.

```bash
# Run remote smoke tests only
bun run --cwd packages/relayer-client test:remote
```

Required environment variables for remote mode:

- `RELAYER_URL` (the deployed worker origin; same value as `RELAYER_URL_STAGE` or `RELAYER_URL_PROD`)
- `RPC_URL` (for example, `https://sepolia.base.org`)
- `TEST_CHAIN_ID` (for example, `84532` for Base Sepolia)

Optional (enables remote top-up helpers in tests):

- `REMOTE_PRIVATE_KEY` (prefunded private key used by remote funding helpers)

Example:

```bash
RELAYER_URL="$RELAYER_URL_STAGE" \
RPC_URL=https://sepolia.base.org \
TEST_CHAIN_ID=84532 \
REMOTE_PRIVATE_KEY=0x... \
bun run --cwd packages/relayer-client test:remote
```
