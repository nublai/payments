---
title: "relayer: pluggable auth engine + Privy integration without worker runtime regressions"
type: solution
date: 2026-03-04
category: integration-issues
tags:
  - relayer
  - auth
  - privy
  - erc8128
  - cloudflare-workers
  - vitest
  - integration
status: solved
---

# relayer: pluggable auth engine + Privy integration without worker runtime regressions

## Summary
We added a pluggable relayer authentication engine that supports `ANY`-mode authorization across ERC-8128 and Privy, controlled by shared `AUTH_PROTECTED_METHODS`. During rollout, we hit integration regressions in Worker test/runtime paths and fixed them without changing external JSON-RPC auth response semantics.

## Problem
Relayer auth was ERC-8128-specific middleware. We needed to support Privy users as a second valid mechanism for protected methods while keeping:
- existing unauthorized response envelope
- relayer-only scope (no relayer-client changes)
- deterministic failure codes and testability for future auth methods

## Symptoms During Implementation
- Full relayer test suite initially failed in queue tests with:
  - `SyntaxError: The requested module 'viem' does not provide an export named 'toHex'`
- A fallback auth test failed after mock cleanup due to malformed signature/message fixtures.
- `verifyErc8128Request` could throw from `viem.verifyMessage` on malformed signatures instead of returning an auth failure.

## Root Causes
1. **Auth architecture gap**
- Existing middleware was mechanism-specific, so adding Privy cleanly required a new abstraction layer (policy + engine + provider interfaces).

2. **Worker runtime coupling from eager Privy import**
- Importing Privy SDK eagerly in the provider increased module-load coupling for paths that do not use Privy auth (for example queue tests loading `src/index.ts`).

3. **Edge-case error handling in ERC-8128 fallback**
- Local EOA verification (`verifyMessage`) could throw on malformed signatures, which was not normalized to `false`.

4. **Test fixture mismatch**
- RPC-failure test fixture used message/signature shapes that caused low-level signature-format errors before intended fallback assertions.

## Solution

### 1) Introduced pluggable auth engine
Added shared auth modules:
- `src/auth/types.ts`
- `src/auth/policy.ts`
- `src/auth/engine.ts`
- `src/auth/middleware.ts`
- `src/auth/providers/erc8128.ts`
- `src/auth/providers/privy.ts`

Behavior:
- `AUTH_PROTECTED_METHODS` controls protected RPC methods for all enabled auth providers.
- Engine authorizes if **any** enabled provider succeeds.
- Denials map to unified auth failure codes and preserve JSON-RPC envelope:
  - `code: -32001`
  - `message: Unauthorized`
  - `error.data.auth_code`

### 2) Wired providers in relayer entrypoint
- `src/index.ts` now uses `authMiddleware({ providers: [createPrivyProvider(), createErc8128Provider()] })`.

### 3) Added Privy env + validation
- Added env keys:
  - `PRIVY_ENABLED`
  - `PRIVY_APP_ID`
  - `PRIVY_APP_SECRET`
  - `AUTH_PROTECTED_METHODS`
- Validation enforces `PRIVY_APP_ID` and `PRIVY_APP_SECRET` when `PRIVY_ENABLED=true`.

### 4) Removed eager Privy SDK runtime coupling
- Changed Privy provider to lazy-load SDK in `verify()` via dynamic import:
  - `import('@privy-io/server-auth')`
- This isolates non-Privy code paths from unnecessary startup coupling.

### 5) Hardened ERC-8128 local verify fallback
- `verifyPersonalMessage(...)` now safely normalizes thrown errors to `false` (no throw-through in auth path).

### 6) Updated hex encoding calls for stability in touched paths
- Replaced touched `toHex` usage with more explicit helpers in relayer paths:
  - `numberToHex`
  - `bytesToHex`

### 7) Secrets hygiene + docs
- `scripts/dev.sh` now uses placeholders (no real Privy secret literals).
- README updated with:
  - shared protected-method policy
  - Privy config keys
  - staged rollout guidance (`wallet_sendPreparedCalls` and optional `wallet_prepareCalls` in stage)

## Verification
All relayer checks passed after fixes:

```bash
cd packages/relayer && bun run test:run
# 47 files, 495 tests passed

cd packages/relayer && bun run lint
# pass

cd packages/relayer && bun run build
# pass (tsc + wrangler build --dry-run)
```

## Prevention Guidance
1. Keep auth providers isolated behind a strict interface; middleware should orchestrate only.
2. Prefer lazy imports for provider SDKs that are not needed in every runtime path.
3. In auth verification, normalize verifier exceptions into explicit auth failures; do not leak low-level throws.
4. For Worker entrypoint tests, treat module-load side effects as integration risks and run full-suite checks early.
5. Keep protected-method policy centralized (`AUTH_PROTECTED_METHODS`) to avoid drift across auth mechanisms.
6. Enforce secrets-in-repo checks for env scripts and docs before merge.

## Test Matrix Covered
- Policy parsing / defaults for `AUTH_PROTECTED_METHODS`
- Engine `ANY` semantics and deterministic failure selection
- ERC-8128 provider mapping and middleware integration
- Privy provider token parsing, appId enforcement, and error classification
- Env validation gates for Privy-enabled deployments
- Full relayer regression suite (including queue paths)

## Related References
- Plan: `docs/plans/2026-03-04-feat-pluggable-relayer-auth-engine-plan.md`
- Related incident docs:
  - `docs/solutions/integration-issues/relayer-polygon-wallet-pending-and-wallet-ready-flapping-20260226.md`
  - `docs/solutions/integration-issues/relayer-polygon-missing-tx-hashes-20260227-.md`
