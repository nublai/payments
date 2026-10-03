---
module: relayer-cli
date: 2026-02-25
problem_type: logic_error
component: keystore
symptoms:
  - "Session/account flows carried v1 single-file compatibility branches even though the CLI is brand new and only uses v2 split keystores"
  - "Missing-keystore session flows could be misclassified as lock contention instead of not-found"
  - "Session list behavior and test fixtures depended on legacy fallback projections"
root_cause: unnecessary_backward_compatibility
resolution_type: code_fix
severity: medium
tags:
  [
    relayer-cli,
    keystore,
    v2-only,
    migration-removal,
    session-flows,
    test-hardening,
  ]
---

# Troubleshooting: Removing Unneeded Legacy Keystore Compatibility in relayer-cli

## Problem

`relayer-cli` included compatibility logic for v1/single-file keystores that were never used in this project. Keeping that compatibility layer increased state complexity and produced avoidable behavior drift in error handling and session/account flows.

## Environment

- Module: `packages/wallet`
- Affected Components:
  - `src/lib/keystore.ts`
  - account/session command libs
  - keystore/account/session tests
- Date: 2026-02-25

## Symptoms

- Branching on `bundle.format` (`legacy` vs `split`) existed across `account-create`, `account-export`, `account-send`, and `session-list`.
- Session commands could surface less actionable errors when format/lock/missing-file conditions interacted.
- Test coverage encoded legacy assumptions (`format: 'legacy'`, v1 fixtures), obscuring the real contract for this new CLI.

## What Didn't Work

**Attempted Approach 1:** Keep migration compatibility "just in case".

- **Why it failed:** The codebase has no real v1 deployment history for this CLI, so compatibility paths created extra branches without serving real users.

**Attempted Approach 2:** Keep mixed model and patch individual regressions.

- **Why it failed:** Local fixes reduced specific failures but left the broader complexity and stale assumptions in place.

## Solution

Enforced a strict **v2 split-keystore-only** model and removed all legacy keystore compatibility.

### 1. Keystore model simplification

In `src/lib/keystore.ts`:

- Removed v1-only artifacts:
  - `RelayerLegacyKeystoreV1`
  - `RelayerKeystore` (v1 alias)
  - `createKeystore`, `decryptKeystore`, `readKeystoreFile`, `writeKeystoreFile`
  - `isLegacyKeystore`, `legacyToRootKeystore`, `legacyToSessionKeystore`
- Simplified `KeystoreBundle` to a single split-only shape.
- Updated `readKeystoreBundle(...)` to accept only v2 root + active session file and otherwise throw:
  - `Unsupported keystore format at <path>; expected version 2 split keystore`

### 2. Removed legacy branches in command flows

- `src/lib/account-create.ts`
  - Resume path now always decrypts root+session split files.
  - Removed legacy writeback handling.
- `src/lib/account-export.ts`
  - Private export now always decrypts split root+session.
- `src/lib/account-send.ts`
  - Signing key now always comes from split session keystore.
- `src/lib/session-list.ts`
  - Always lists from `sessionRef.dir` split sessions; no legacy projection fallback.

### 3. Kept errors actionable

- Preserved missing-file behavior (`KEYSTORE_NOT_FOUND`) for session create JSON flows.
- Added explicit unsupported-format mapping in session error translators to avoid generic `UNKNOWN` where possible.

### 4. Test contract aligned to v2-only

- Removed v1 fixture paths and `format: 'legacy'` assumptions from account/session tests.
- Rewrote `tests/keystore.test.ts` to split-only coverage.
- Added explicit unsupported-root-format coverage for `readKeystoreBundle(...)`.

## Why This Works

1. The runtime model now matches actual product reality (brand-new CLI, split-only stores).
2. Fewer state branches reduce drift risk and simplify reasoning across account/session operations.
3. Tests now assert the true compatibility boundary, preventing accidental reintroduction of legacy behavior.

## Validation

Commands run:

```bash
bun run --cwd packages/wallet test
bunx tsc --noEmit -p packages/wallet/tsconfig.json
```

Results:

- `packages/wallet` tests passed (`143 pass`, `0 fail`).
- Typecheck passed (`0 errors`).

## Prevention

- Do not add backward-compatibility paths without concrete deployed data requiring them.
- For any format/model change, define and enforce a single canonical runtime shape in types.
- Add format-boundary tests early (supported shape + explicit unsupported shape).
- When removing a union discriminator, immediately sweep command libs and tests for stale branches.

## Related Issues

- [relayer-cli JSON routing and sanitization regressions](relayer-cli-json-routing-and-sanitization-regressions-20260225.md)
- [wallet-cli ABI module resolution CI build failure](../build-errors/wallet-cli-abi-module-resolution-ci-build-failure-20260225.md)
