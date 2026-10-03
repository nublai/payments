# Agentic Payments

Private copy of the payments surface from [giuseppecrj/chat](https://github.com/giuseppecrj/chat). Chat was not modified.

This is a source copy, not a rewrite. Package names, versions, and file contents that were copied are unchanged. Nothing here documents APIs that are not already in those files.

## Packages

Copied in full (every file tracked on `main` in chat):

- `packages/wallet` — `@towns-labs/wallet`
- `packages/relayer-client` — `@towns-labs/relayer-client`
- `packages/relayer` — `@towns-labs/relayer`
- `packages/sdk` — `@towns-labs/sdk`
- `packages/encryption` — `@towns-labs/encryption`
- `packages/sdk-crypto` — `@towns-labs/sdk-crypto`
- `packages/rpc-connector` — `@towns-labs/rpc-connector`
- `packages/web3` — `@towns-labs/web3`
- `packages/utils` — `@towns-labs/utils`
- `packages/proto` — `@towns-labs/proto` (committed files only; see below)
- `packages/contracts` — `@towns-labs/contracts` (full protocol copy: Solidity, Foundry, tests, scripts)

Shared config copied because included packages extend or import it:

- `packages/tsconfig.base.json`
- `vitest.config.mts` (several package vitest configs import `../../vitest.config.mjs`; the file in chat is `vitest.config.mts`)
- `.bun-version` (`1.3.3`) and `bunfig.toml`
- Root `package.json` workspaces are bun workspaces (`packages/*`), matching chat. `packageManager` is `bun@1.3.3`. The `viem` resolution `2.45.1` is the pin from chat's root `resolutions`. Root `typescript` is `~5.8.3`, the version those packages declare.

## What was slimmed

`packages/contracts` (`@towns-labs/contracts`) is the full protocol copy (Solidity, Foundry, tests, scripts). Wallet, relayer-client, and relayer import only:

- `@towns-labs/contracts/abis`
- `@towns-labs/contracts/deployments`

`@towns-labs/web3` (pulled in by the SDK) also imports `@towns-labs/contracts/config/deployments.json`.

`@towns-labs/utils` was not reduced to the three wallet loggers. Those loggers live in `src/dlog.ts`, which imports `src/binary.ts`, `src/utils.ts`, and `src/envUtils.ts`. The SDK types the wallet imports (`Client`, `SyncMode`, `SignerContext`, `StreamStateView`) also import `check`, `delegate`, and the rest of the utils barrel, so every source module under `packages/utils/src` is required. The package was copied in full.

`@towns-labs/proto` was not reduced to the six wallet symbols. Those symbols are `ExportedDeviceSchema`, `ExportedDevice`, `MembershipOp`, `BearerTokenSchema`, `WalletSessionTokenSchema`, and `SnapshotCaseType`. `SnapshotCaseType` is declared in `packages/proto/src/types.ts`. The others are generated protobuf exports. `packages/proto/src/gen/` is gitignored in chat and was not in the clone, so those generated files were not copied and were not regenerated. The SDK, encryption, and sdk-crypto imports from `@towns-labs/proto` cover far more than those six symbols, and the package entry re-exports every generated module. The committed proto package (12 files) was copied as-is.

`@towns-labs/sdk` was copied as-is. Wallet imports only types `Client`, `SyncMode`, `SignerContext`, and `StreamStateView` from the package root. Following local imports from `src/client.ts`, `src/signerContext.ts`, and `src/streamStateView.ts` reaches 78 of 114 non-test source files, and the generated barrel `src/index.ts` re-exports the rest (sync-agent, app registry, and others). Those files import `@towns-labs/encryption`, `@towns-labs/proto`, `@towns-labs/rpc-connector`, `@towns-labs/sdk-crypto`, `@towns-labs/utils`, and `@towns-labs/web3`, which were copied in full for the same reason.

## Not copied

- `packages/proto/src/gen/**` (not in git)
- Apps, bots, clients, servers, and other workspace packages (app-framework, stream-metadata, and the rest)
