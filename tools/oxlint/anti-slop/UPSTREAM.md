# Vendored anti-slop oxlint plugin

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (committed 2026-09-10)
- Vendored: 2026-10-08
- Scope: copied `src/` minus `*.test.ts`, unmodified. The `effect/` rules are copied but not enabled.
- Upstream license: MIT, Copyright (c) 2026 Dillon Mulroy.

Loaded by the root `.oxlintrc.json` through `jsPlugins` from `./tools/oxlint/anti-slop/index.ts`. Its only runtime import is `@oxlint/plugins`, pinned in the root `package.json`.

Do not install the npm package `oxlint-plugin-anti-slop`. That name is a 0.0.0 placeholder published by an unrelated party, not by the upstream author.

## ESLint Stylistic

`vendor/eslint-stylistic/` is a port of ESLint Stylistic's `padding-line-between-statements` rule, which is MIT-licensed. Its `LICENSE` and `UPSTREAM.md` are kept verbatim from anti-slop and must stay with every copy.

## Updating

Copy `src/` from a new upstream commit, drop `*.test.ts`, keep `vendor/eslint-stylistic/LICENSE`, and update the commit and date above.
