# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`@towns-labs/relayer-client` is a slim, viem-style SDK for interacting with the Towns Relayer. It enables gasless transactions through EIP-7702 account delegation and intent-based execution. It uses `viem` for client/runtime primitives and imports shared RPC schema types from `@towns-labs/relayer/rpc/schema/*` to keep contracts aligned.

## Package Relationship

This package is **tightly coupled** with `@towns-labs/relayer` (`packages/relayer/`):

| Package                         | Role                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| `relayer`                       | Backend - Cloudflare Worker exposing JSON-RPC 2.0 endpoints |
| `relayer-client` (this package) | Client SDK - TypeScript library that calls the relayer      |

**Key dependencies:**

- This package consumes RPC methods defined in `relayer/src/rpc/methods/`
- This package imports shared RPC schema types from `relayer/src/rpc/schema/` (via `@towns-labs/relayer/rpc/schema/...`)
- Both packages share identical EIP-712 type definitions for intent signing
- Changes to relayer's request/response schemas require updates here

**This package contains the canonical integration tests for both packages** (see Testing section).

## Commands

```bash
# Build
bun run build               # Compile to dist/
bun run cb                  # Clean + build

# Testing (automatically starts services if needed)
bun run test                # Run all tests
bun run test:integration    # Integration tests (starts services, runs tests, cleanup)
bun run test:integration:watch  # Watch mode (services stay running)

# Development
bun run dev                 # Start Anvil + relayer (keep running for manual testing)
./scripts/dev.sh --help     # Show all options

# Quality
bun run lint                # oxlint with warnings as errors
bun run lint:fix            # Auto-fix lint issues
bun run format              # Prettier formatting
```

## Local Integration Environment

The canonical way to boot Anvil + relayer for integration tests is `scripts/dev.sh`:

```bash
./scripts/dev.sh --help
```

Important behavior and knobs:

- Depends on Foundry (`anvil`, `forge`) and Bun.
- Uses `../contracts` for deploys and `../relayer/scripts/dev.sh` to start the relayer.
- Clears relayer Durable Object state on cleanup: `../relayer/.wrangler/state`.
- Logs: `/tmp/anvil.log` and `/tmp/relayer.log`.
- Env vars: `FORK_RPC_URL`, `FORK_BLOCK`, `BLOCK_TIME`, `ANVIL_PORT`, `RELAYER_PORT`.

## Architecture

### Viem Decorator Pattern

The SDK extends viem's PublicClient via a decorator:

```typescript
const client = createPublicClient({ chain, transport }).extend(
  relayerActions({ relayerUrl: "..." }),
);

// Client now has both viem methods and relayer actions
```

### Source Structure

- `src/actions/` - Individual action functions
- `src/decorators/relayer.ts` - Main decorator that bundles all actions
- `src/transport.ts` - JSON-RPC 2.0 transport layer
- `src/types.ts` - All TypeScript interfaces
- `src/chains.ts` - Supported chain metadata and defaults
- `src/utils/` - Signature wrapping, ERC-1271, key hashing utilities

### Client Methods (9 core methods)

| Method              | RPC Method                 | Purpose                                  |
| ------------------- | -------------------------- | ---------------------------------------- |
| `checkHealth`       | (health endpoint)          | Verify relayer is running                |
| `getCapabilities`   | (capabilities endpoint)    | Get relayer features                     |
| `prepareCalls`      | `wallet_prepareCalls`      | Get typed data, nonce, gas for signing   |
| `sendPreparedCalls` | `wallet_sendPreparedCalls` | Submit signed calls to relayer           |
| `getCallsStatus`    | `wallet_getCallsStatus`    | Get bundle/transaction status            |
| `upgradeAccount`    | `wallet_upgradeAccount`    | Upgrade EOA to delegated account         |
| `getKeys`           | `wallet_getKeys`           | Get authorized keys for an account       |
| `verifySignature`   | `wallet_verifySignature`   | Verify signature for a delegated account |
| `getCallsHistory`   | `wallet_getCallsHistory`   | Get bundle history for an EOA            |

### Exported Utilities (not on client)

```typescript
// Signature wrapping for authorized keys
wrapSignature(signature, keyHash, prehash?)  // Wrap signature for TownsAccount validation

// ERC-1271 digest transform (for smart contract signers)
computeErc1271Digest(digest, account)  // Transform digest for ERC-1271 signing

// Key utilities
computeKeyHash(keyType, publicKey)  // Compute key hash
encodeSecp256k1Key(address)         // Encode secp256k1 key

// Polling helper
waitForBundle(client, { id })       // Poll until bundle reaches final status

// Error decoding
decodeIntentError(data)             // Decode intent error from bytes4 selector
```

### Two-Step Flows

**Account Upgrade (EIP-7702 Delegation):**

1. `wallet_prepareUpgradeAccount` → get digests
2. Sign both auth + exec digests
3. `wallet_upgradeAccount` → submit signatures

**Calls Execution:**

```typescript
// 1. Prepare
const prepared = await client.prepareCalls({
  from: accountAddress,
  calls: [{ target, value: 0n, data }],
});

// 2. Sign (user's responsibility - with viem)
const signature = await walletClient.signTypedData(prepared.typedData);

// 3. Wrap if using authorized key
const wrapped = wrapSignature(signature, keyHash);

// 4. Send
const { id } = await client.sendPreparedCalls({
  context: prepared.context,
  signature: wrapped,
});

// 5. Wait
const status = await waitForBundle(client, { id });
```

### Key Types

```typescript
interface Call { target: Address; value: bigint; data: Hex }
interface PrepareCallsResponse {
  context: PrepareCallsContext  // Opaque, pass to sendPreparedCalls
  digest: Hex                   // EIP-712 digest
  typedData: {...}              // For signing with viem
  key?: PreparedKeyInfo         // Key info (if key hash provided)
}
```

## Testing

### Canonical Integration Tests

**IMPORTANT:** The `test/scenarios/` directory contains the **canonical integration tests for both relayer and relayer-client**. These tests exercise the full flow: client → relayer → blockchain.

Scenario tests must be run when modifying:

- **relayer**: RPC methods, signature verification, nonce management, transaction broadcasting
- **relayer-client**: Actions, transport, type definitions

### Test Layout

- `test/scenarios/` - End-to-end integration scenarios (canonical)
- `test/helpers/` - Shared helpers and fixtures
- `test/setup.ts` - Global test setup

### Running Tests

The test scripts automatically manage Anvil and relayer services:

```bash
# Run integration tests (handles everything automatically)
bun run test:integration

# Watch mode for development
bun run test:integration:watch

# If services are already running, they'll be reused
bun run dev                 # Start services in one terminal
bun run test:integration    # Reuses existing services
```

### Running Specific Scenarios

**For targeted testing during feature development**, pass a filter pattern after `--`:

```bash
# Run only account delegation tests
bun run test:integration -- 01-account

# Run only get-keys tests
bun run test:integration -- 07-get-keys

# Run only signature verification tests
bun run test:integration -- 08-verify

# Run simplified API tests
bun run test:integration -- 10-simplified

# Watch mode with filter
bun run test:integration:watch -- 01-account
```

### Scenario Test Mapping

Use this table to identify which scenario to run based on your changes:

| If you changed...            | Run this scenario         |
| ---------------------------- | ------------------------- |
| Account creation, delegation | `-- 01-account`           |
| `wallet_getKeys`             | `-- 07-get-keys`          |
| Signature verification       | `-- 08-verify`            |
| Simplified API               | `-- 10-simplified`        |
| `wallet_getCallsHistory`     | `-- 15-get-calls-history` |

### Scenario Test Coverage

Tests in `test/scenarios/` verify:

- Account creation and EIP-7702 delegation
- Authorized key execution with signature wrapping
- Key retrieval via `wallet_getKeys`
- Signature verification (ERC-1271)
- Bundle status polling
- Call history retrieval via `wallet_getCallsHistory`
- Error handling and edge cases

### Recommended Workflow for Relayer Changes

When making changes to `packages/relayer/`:

1. Make changes in the relayer package
2. Run relayer unit tests: `cd ../relayer && bun run test:run`
3. **Run the specific scenario** that tests your change (see mapping table above):
   ```bash
   bun run test:integration -- <scenario-filter>
   ```
4. **Before committing**, run all integration tests:
   ```bash
   bun run test:integration
   ```
5. If adding new RPC methods, add corresponding scenario tests in `test/scenarios/`

### Recommended Workflow for Relayer-Client Changes

When making changes to this package:

1. Make changes to actions/types/transport
2. **Run the specific scenario** that tests your change:
   ```bash
   bun run test:integration -- <scenario-filter>
   ```
3. **Before committing**, run all integration tests:
   ```bash
   bun run test:integration
   ```

### Adding New Scenario Tests

This package is the **single source of truth** for integration test documentation.

When adding a new scenario test file:

1. Create the test file in `test/scenarios/` with the naming convention `XX-description.test.ts`
2. **Update the Scenario Test Mapping table above** to include your new scenario

## Relayer-Client Gotchas

- **Local test boot is stateful**: `scripts/dev.sh` clears `../relayer/.wrangler/state` on cleanup, so DO state is reset between runs.
- **Chain ID matters**: in fork mode `TEST_CHAIN_ID=8453`, local mode uses `31337` (set by `scripts/dev.sh`).
- **Keep EIP-712 types in sync**: any intent type changes must be mirrored with relayer's definitions or signatures will break.

## Signature Testing Gotchas

### SuperAdmin Signer Must Be Separate EOA

When testing signature verification (`wallet_verifySignature`), the superAdmin key's signer address must be a **different** EOA than the delegated account address.

**Why**: After EIP-7702 delegation, the account has bytecode. When validating signatures, Solady's `SignatureCheckerLib` sees the signer has code and calls `isValidSignature()` recursively instead of doing ECDSA recovery. This causes validation to fail.

```typescript
// CORRECT: Use two separate keypairs
const accountPrivateKey = generatePrivateKey();
const accountAddress = privateKeyToAccount(accountPrivateKey);

const signerPrivateKey = generatePrivateKey(); // Different key!
const signerAccount = privateKeyToAccount(signerPrivateKey);

const encodedSuperAdminKey = encodeAbiParameters(
  [{ type: "address" }],
  [signerAccount.address], // Signer address, NOT account address
);

// Sign with signerPrivateKey, not accountPrivateKey
const signature = await sign({
  hash: erc1271Digest,
  privateKey: signerPrivateKey,
});
```

### ERC-1271 Digest Transformation

When signing for `wallet_verifySignature`, you must sign the **ERC-1271 transformed digest**, not the original:

```typescript
const originalDigest = keccak256(data);
const erc1271Digest = computeErc1271Digest(originalDigest, accountAddress);
const signature = await sign({
  hash: erc1271Digest,
  privateKey: signerPrivateKey,
});
```

See `test/scenarios/08-verify-signature.test.ts` for the full `computeErc1271Digest` implementation.
