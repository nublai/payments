# relayer-cli

## 7.3.1

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@7.3.1
  - @agentic-payments/proto@7.3.1
  - @agentic-payments/relayer-client@7.3.1
  - @agentic-payments/sdk@7.3.1
  - @agentic-payments/utils@7.3.1

## 7.3.0

### Minor Changes

- #964 `10c2121` Thanks [@giuseppecrj](https://github.com/giuseppecrj)! - Add escrow commands for create, status, settle, and refund.

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@7.3.0
  - @agentic-payments/proto@7.3.0
  - @agentic-payments/relayer-client@7.3.0
  - @agentic-payments/sdk@7.3.0
  - @agentic-payments/utils@7.3.0

## 7.2.0

### Minor Changes

- #941 `23ced48` Thanks [@giuseppecrj](https://github.com/giuseppecrj)! - Add wallet agent-to-agent messaging with named channels, shared rendezvous, listen/send flows, and smoke-test tooling.

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@7.2.0
  - @agentic-payments/proto@7.2.0
  - @agentic-payments/relayer-client@7.2.0
  - @agentic-payments/sdk@7.2.0
  - @agentic-payments/utils@7.2.0

## 7.1.0

### Minor Changes

- #896 `cd9a8ae` Thanks [@giuseppecrj](https://github.com/giuseppecrj)! - 1. **Session-key ETH/USDC UX improvements**
  - Added `--session <name>` to `tw account send` (no need to activate/export first).
  - Preserved actionable errors for `--session` resolution failures.
  - Kept `--session` and `--session-file` mutually exclusive.
  2. **`--full-access` safety + clarity**
  - Enforced mutual exclusion between `--full-access` and scoped flags (`--target`, `--selector`, `--spend-limit`, `--spend-period`, `--spend-limit-raw`).
  - Prevented silent overrides.
  - Updated CLI help/README to make behavior explicit.
  3. **Wildcard behavior documentation parity**
  - Documented that omitting `--target`/`--selector` means wildcard call permissions.
  - Applied parity across both `session create` and `session rotate` help/docs.
  4. **Spend period correctness**
  - Tightened period validation to explicit enums.
  - Removed fallback behavior that could map unknown periods incorrectly.
  - Verified `monthly`/`month` path via tests and enum handling.
  5. **Spend-limit unit overhaul**
  - Added `--spend-limit-raw` (base units).
  - Changed `--spend-limit` to human token units (USDC-style decimals parsing).
  - Added guardrail: large integer-looking values fail with an actionable message pointing to `--spend-limit-raw`.
  - Applied consistently to session create/rotate and permissions grant.
  6. **Actionable account-status warning**
  - Improved missing spend-permission warning to include remediation commands users can run immediately.
  7. **Type-safety + idiomatic hardening**
  - Removed remaining `as any` hotspots in CLI/session/permissions flows.
  - Typed `getKeys` deps with `GetKeysResponse`.
  - Replaced float-based amount positivity check with safer string/units validation.
  - Replaced prompt-layer `process.exit` with typed cancellation (`PromptCancelledError`) handled at CLI boundary.
  - Improved rollback error reporting in password update flow (no silent catch).
  8. **Dead-code cleanup**
  - Removed unused imports/functions flagged by lint in relayer-cli.
  9. **Verification**
  - Lint clean (`oxlint`), tests passing, and build passing for `packages/wallet`.
  - Latest commit for the final hardening pass: `883e6c2c9c`.

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@7.1.0
  - @agentic-payments/relayer-client@7.1.0

## 7.0.0

### Major Changes

- #885 `359ca49` Thanks [@giuseppecrj](https://github.com/giuseppecrj)! - Rename the CLI package to `@agentic-payments/wallet` and keep `agentic-payments-wallet`/`tw` binaries so Bun users can run it via `bunx @agentic-payments/wallet`.

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@7.0.0
  - @agentic-payments/relayer-client@7.0.0

## 6.0.0

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@6.0.0
  - @agentic-payments/relayer-client@6.0.0

## 5.0.0

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@5.0.0
  - @agentic-payments/relayer-client@5.0.0

## 4.1.2

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@4.1.2
  - @agentic-payments/relayer-client@4.1.2

## 4.1.1

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@4.1.1
  - @agentic-payments/relayer-client@4.1.1

## 4.1.0

### Minor Changes

- #794 `82926e9` Thanks [@giuseppecrj](https://github.com/giuseppecrj)! - Initial release of Wallet CLI (`agentic-payments-wallet` / `tw`). Includes account creation and management, session key lifecycle, permission grants and revocation, delegation, balance queries, and transaction sending — all from the terminal with encrypted local keystore storage.

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@4.1.0
  - @agentic-payments/relayer-client@4.1.0

## 4.0.0

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@4.0.0
  - @agentic-payments/relayer-client@4.0.0

## 3.4.1

### Patch Changes

- Updated dependencies []:
  - @agentic-payments/contracts@3.4.1
  - @agentic-payments/relayer-client@3.4.1

## 3.4.0

### Minor Changes

- #759 `d1652ec` Thanks [@giuseppecrj](https://github.com/giuseppecrj)! - Add root `tw address` alias with funding-oriented output options, including `--link`, `--qr`, `--amount`, `--token`, and `--decimals`, plus schema/help/docs updates and regression coverage.

### Patch Changes

- Updated dependencies [`8594d4c`]:
  - @agentic-payments/contracts@3.4.0
  - @agentic-payments/relayer-client@3.4.0

## 0.1.0

### Minor Changes

- #670 `03ff3f0` Thanks [@miguel-nascimento](https://github.com/miguel-nascimento)! - Create @agentic-payments/deployments, remove @agentic-payments/generated, gut ethers v5 contract layer from @agentic-payments/web3

### Patch Changes

- Updated dependencies [`03ff3f0`]:
  - @agentic-payments/deployments@3.3.0
  - @agentic-payments/relayer-client@3.3.0
