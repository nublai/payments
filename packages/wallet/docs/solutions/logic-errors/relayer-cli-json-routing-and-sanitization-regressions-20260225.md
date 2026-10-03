---
module: relayer-cli
date: 2026-02-25
problem_type: logic_error
component: tooling
symptoms:
  - "`tw --env dev <command> --json` could be routed as unknown command because `dev` was treated as the command token"
  - "`run()` called `rendered.waitUntilExit()` without `await`, allowing early return and potential unhandled async failures"
  - "JSON error sanitization rewrote URL-like strings (for example `https://...`) into malformed output while redacting paths"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [relayer-cli, json-mode, argument-parsing, ink, sanitization]
---

# Troubleshooting: relayer-cli JSON Routing and Sanitization Regressions

## Problem

`relayer-cli` had three review-identified logic bugs affecting JSON mode correctness and reliability: top-level command detection around `--env`, non-awaited Ink exit handling, and over-broad path sanitization.

## Environment

- Module: `packages/wallet`
- Affected Component: CLI entrypoint and JSON envelope utilities
- Date: 2026-02-25

## Symptoms

- JSON routing could misclassify `--env` values as commands in top-level dispatch.
- Renderer completion was not awaited in version/default render paths.
- Filesystem path redaction logic could also mutate URL text in error messages.

## What Didn't Work

**Attempted Solution 1:** Keep using first non-flag token (`argv.find(...)`) as command in JSON mode.

- **Why it failed:** Value flags such as `--env dev` have non-flag values that are not commands.

**Attempted Solution 2:** Keep broad `/.../` replacement for message redaction.

- **Why it failed:** URL paths also match broad slash patterns and were rewritten unintentionally.

## Solution

Implemented three targeted fixes with regression tests:

1. Added `resolveTopLevelCommand(argv)` in `src/index.tsx`:

- Skips `--env` and its following value.
- Skips inline `--env=<value>` tokens.
- Uses first remaining non-flag token as command.

2. Awaited Ink renderer exit in `run()`:

- Changed both `rendered.waitUntilExit()` calls to `await rendered.waitUntilExit()`.

3. Tightened redaction regexes in `src/lib/json-output.ts`:

- Redacts unix/windows path-like tokens only when preceded by safe boundaries.
- Preserves URLs while still masking filesystem paths.

### Key code changes

```ts
// src/index.tsx
function resolveTopLevelCommand(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === "--env") {
      index += 1;
      continue;
    }
    if (token.startsWith("--env=")) continue;
    if (!token.startsWith("-")) return token;
  }
  return undefined;
}
```

```ts
// src/index.tsx
const rendered = render(<App argv={argv} version={version} />)
await rendered.waitUntilExit()
```

```ts
// src/lib/json-output.ts
return message
  .replace(/(^|[\s("'`])\/[A-Za-z0-9._/-]+/g, "$1<path>")
  .replace(/(^|[\s("'`])[A-Za-z]:\\[A-Za-z0-9._\\-]+/g, "$1<path>")
  .replace(/(^|[\s("'`])\\\\[A-Za-z0-9._\\-]+/g, "$1<path>");
```

## Why This Works

1. Command resolution now explicitly handles flag-value structure instead of assuming any non-flag token is a command.
2. Awaiting renderer shutdown ensures async lifecycle completion before `run()` returns.
3. Boundary-constrained redaction targets filesystem paths while avoiding accidental URL corruption.

## Prevention

- For CLI top-level parsing, use explicit value-flag skipping logic rather than naive token scans.
- Add regression tests when JSON router behavior depends on global argv parsing.
- Keep sanitization rules specific to intended token classes; test redaction against representative non-target strings (URLs, identifiers).

## Validation

Commands run:

```bash
bun run --cwd packages/wallet test
bun run --cwd packages/wallet build
bun run lint
```

Results:

- `packages/wallet` tests passed (143/143).
- `packages/wallet` build passed.
- Workspace lint failure was unrelated to this fix (`packages/web3` and `packages/sdk` existing issues).

## Related Issues

- See also: [wallet-cli ABI module resolution CI build failure](../build-errors/wallet-cli-abi-module-resolution-ci-build-failure-20260225.md)
