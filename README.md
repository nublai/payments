# Agentic Payments

Private copy of the onchain payments surface from [giuseppecrj/chat](https://github.com/giuseppecrj/chat). Chat was not modified.

This is a source copy of the payments packages, then slimmed to drop the Towns chat graph the wallet does not need. Package names and versions of what remains are unchanged. Nothing here documents APIs that are not already in those files.

## Packages

- `packages/wallet` — `@towns-labs/wallet` (onchain CLI: account, session, daemon, permissions, escrow, send, swap, bridge, address, login, logout). The `tw chat` command group and chat-only wallet modules are not included.
- `packages/relayer-client` — `@towns-labs/relayer-client`
- `packages/relayer` — `@towns-labs/relayer`
- `packages/proto` — `@towns-labs/proto` (committed files only; see below)
- `packages/contracts` — `@towns-labs/contracts` (full protocol copy: Solidity, Foundry, tests, scripts)

Shared config copied because included packages extend or import it:

- `packages/tsconfig.base.json`
- `vitest.config.mts` (several package vitest configs import `../../vitest.config.mjs`; the file in chat is `vitest.config.mts`)
- `.bun-version` (`1.3.3`) and `bunfig.toml`
- Root `package.json` workspaces are bun workspaces (`packages/*`), matching chat. `packageManager` is `bun@1.3.3`. The `viem` resolution `2.45.1` is the pin from chat's root `resolutions`. Root `typescript` is `~5.8.3`, the version those packages declare.

## What was slimmed

Removed, because they exist for the Towns chat / SDK graph and are not imported by the remaining payments code:

- `packages/sdk`
- `packages/encryption`
- `packages/sdk-crypto`
- `packages/rpc-connector`
- `packages/web3`
- `packages/utils`

`packages/wallet` no longer depends on `@towns-labs/sdk` or `@towns-labs/utils`. The three dlog logger setters the CLI runtime used (`setDlogErrorLogger`, `setDlogInfoLogger`, `setDlogWarnLogger`) live in `packages/wallet/src/lib/dlog.ts`.

`packages/contracts` (`@towns-labs/contracts`) is the full protocol copy (Solidity, Foundry, tests, scripts) and was not reduced. Wallet, relayer-client, and relayer import only:

- `@towns-labs/contracts/abis`
- `@towns-labs/contracts/deployments`

`@towns-labs/proto` is still required for login and for agent device material stored on session keystores. The package entry exports only `BearerTokenSchema`, `WalletSessionTokenSchema`, `ExportedDeviceSchema`, and the `ExportedDevice` type. Those messages were copied from chat `protocol/payloads.proto` (`BearerToken`, `WalletSessionToken`, `ExportedDevice`) into `packages/proto/schema/payments.proto` and generated with the repo's `buf` / `protoc-gen-es` (`target=ts`) into `packages/proto/src/gen/payments_pb.ts`. The rest of chat's generated proto tree is not included. `MembershipOp` and `SnapshotCaseType` are not exported; nothing in the slimmed wallet imports them.

## Not copied

- The rest of `packages/proto/src/gen/**` (only `payments_pb.ts` is generated here)
- Apps, bots, clients, servers, and other workspace packages (app-framework, stream-metadata, and the rest)
- The Towns chat command surface (`tw chat`) and the wallet modules that only served it
