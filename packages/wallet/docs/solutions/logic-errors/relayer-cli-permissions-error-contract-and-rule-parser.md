---
title: "Relayer CLI permissions: restore JSON usage error contract and reject invalid spend wildcard rule"
date: "2026-02-25"
category: "logic-errors"
components:
  - "packages/wallet/src/index.tsx"
  - "packages/wallet/src/lib/permissions-common.ts"
  - "packages/wallet/tests/json-router-cli.test.ts"
  - "packages/wallet/tests/permissions-flow.test.ts"
tags:
  - "relayer-cli"
  - "permissions"
  - "json-contract"
  - "argument-validation"
  - "rule-parsing"
status: "solved"
---

# Problem

Two correctness regressions were found in the new `tw permissions` command group:

1. `tw permissions grant <key-ref> --json` without `--type` returned `UNKNOWN` with a generic message instead of a typed usage error (`MISSING_ARGUMENT`).
2. `parseRuleId("spend:any:<period>")` accepted `any` and mapped it to `0x3232...` (the call wildcard target constant), which is not valid spend token semantics.

# Symptoms

- Automation consuming JSON envelopes could not distinguish user input error from internal failure.
- `permissions revoke --rule spend:any:day` could appear successful but target an invalid spend token key, causing misleading no-op behavior.

# Root Cause

## 1) JSON error contract drift

Router validation in `permissions grant` threw a generic `Error` for missing `--type`. Generic errors are mapped to `UNKNOWN`, and `UNKNOWN` is intentionally sanitized to `"An unexpected error occurred"` in JSON output.

## 2) Spend rule parser mixed call and spend wildcard semantics

`parseRuleId` used `parseAddressOrAny` for spend token parsing. That helper is correct for call target parsing (`any -> 0x3232...`) but incorrect for spend tokens.

# Solution

## 1) Emit typed usage error for missing `--type`

Changed `permissions grant` router branch to throw:

- `new PermissionsError('MISSING_ARGUMENT', 'Usage requires --type <call|spend>. Run tw permissions grant --help.')`

This restores stable JSON contract behavior and usage-level exit semantics.

Code reference:

- `packages/wallet/src/index.tsx` (grant branch validation)

## 2) Reject `spend:any:<period>` and require real token address

Updated `parseRuleId` spend branch to:

- explicitly reject `arg1 === 'any'`
- require `isAddress(arg1)`
- normalize via `getAddress(arg1)`

Code reference:

- `packages/wallet/src/lib/permissions-common.ts` (spend rule parsing)

# Tests Added

1. JSON contract regression test:

- `packages/wallet/tests/json-router-cli.test.ts`
- `permissions grant missing --type in json mode returns missing argument`

2. Rule parser regression test:

- `packages/wallet/tests/permissions-flow.test.ts`
- `parseRuleId rejects spend:any aliases`

# Verification

Executed:

- `bun test packages/wallet/tests/json-router-cli.test.ts`
- `bun test packages/wallet/tests/permissions-flow.test.ts`
- `bun test packages/wallet/tests`

Result: all tests passing (`167 pass, 0 fail`).

# Prevention

1. Keep all CLI argument contract failures typed (`MISSING_ARGUMENT`, `RULE_PARSE_FAILED`, etc.) before JSON wrapping.
2. Avoid sharing wildcard parsers across domains unless semantics are identical (call target vs spend token).
3. Add parser-level unit tests whenever introducing string IDs (`call:*`, `spend:*`) to lock alias semantics.
4. For JSON CLI surfaces, add at least one test for each required flag omission path.

# Related Context

- Brainstorm/plan context:
  - `docs/brainstorms/2026-02-25-permissions-cli-brainstorm.md`
  - `docs/plans/2026-02-25-feat-permissions-cli-command-group-plan.md`
