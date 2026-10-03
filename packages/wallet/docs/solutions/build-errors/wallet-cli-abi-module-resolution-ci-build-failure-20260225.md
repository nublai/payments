---
module: wallet-cli
date: 2026-02-25
problem_type: build_error
component: tooling
symptoms:
  - "GitHub Actions checks Common_CI and Integration CI failed at @agentic-payments/wallet-cli#build"
  - "Bun bundling failed with: Could not resolve '@agentic-payments/deployments/abis'"
  - "Local relayer-cli build/tests also failed with unresolved ABI module imports"
root_cause: missing_tooling
resolution_type: dependency_update
severity: high
tags:
  [wallet-cli, ci, bun, module-resolution, contracts-abi, workspace-dependency]
---

# Troubleshooting: wallet-cli ABI Module Resolution Failure in CI

## Problem

`@agentic-payments/wallet-cli` failed to build in CI because session command files imported an ABI module path that was no longer resolvable in the current workspace/package graph.

## Environment

- Module: `packages/wallet` (`@agentic-payments/wallet-cli`)
- Affected Component: Package/build tooling and workspace dependency wiring
- Date: 2026-02-25

## Symptoms

- GitHub checks failed:
  - `Common_CI` (CI workflow)
  - `Integration CI` (CI workflow)
- Error in logs:
  - `Could not resolve: "@agentic-payments/deployments/abis"`
- Affected files:
  - `src/lib/session-create.ts`
  - `src/lib/session-rotate.ts`
  - `src/lib/session-revoke.ts`

## What Didn't Work

**Attempted Solution 1:** Switch imports from `@agentic-payments/deployments/abis` to `@agentic-payments/contracts/abis`.

- **Why it failed:** `packages/wallet/package.json` did not declare `@agentic-payments/contracts` as a dependency, so module resolution still failed at build time.

## Solution

Use the canonical ABI export path and ensure the package dependency graph includes the contracts package.

**Code changes**:

```ts
// Before
import { accountAbi } from "@agentic-payments/deployments/abis";

// After
import { accountAbi } from "@agentic-payments/contracts/abis";
```

Applied in:

- `packages/wallet/src/lib/session-create.ts`
- `packages/wallet/src/lib/session-rotate.ts`
- `packages/wallet/src/lib/session-revoke.ts`

**Dependency change**:

```json
{
  "dependencies": {
    "@agentic-payments/contracts": "workspace:^"
  }
}
```

Applied in:

- `packages/wallet/package.json`
- `bun.lock` regenerated via install

**Commands run**:

```bash
bun install
bun run --cwd packages/wallet build
bun run --cwd packages/wallet test
```

## Why This Works

1. ABI imports are now aligned with the canonical package export (`@agentic-payments/contracts/abis`) used elsewhere in the repo.
2. The consuming package (`@agentic-payments/wallet-cli`) explicitly depends on `@agentic-payments/contracts`, so Bun can resolve the module during bundling.
3. Lockfile regeneration ensures CI and local environments resolve the same graph.

## Prevention

- When moving/renaming module paths, verify both:
  - import path correctness
  - dependency declaration in the consuming package
- Add a quick pre-push check for this package:
  - `bun run --cwd packages/wallet build`
  - `bun run --cwd packages/wallet test`
- Treat CI module-resolution errors as package-graph issues first, not only source-code issues.

## Related Issues

No related issues documented yet.
