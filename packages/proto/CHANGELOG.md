# @agentic-payments/proto

## 7.3.1

## 7.3.0

## 7.2.0

## 7.1.0

## 7.0.0

## 6.0.0

### Major Changes

- #869 `961e84a` Thanks [@miguel-nascimento](https://github.com/miguel-nascimento)! - Rename specialist invocation capability field from `capabilityName`/`capability_name` to `name`.
  - `SpecialistCapabilityInvocation` now uses `name` in protobuf/TS/Go generated types.
  - `GetBulkAgentProposals` request payloads now send invocation `name` and map it through backend fan-out.
  - `@agentic-payments/app-framework` proposal processing now reads `invocation.name`.

## 5.0.0

### Patch Changes

- #863 `d0cd833` Thanks [@giuseppecrj](https://github.com/giuseppecrj)! - Add specialist proposal metadata propagation for concierge fan-out.

  `GetBulkAgentProposalsRequest` and `AppServiceRequest.ProposalsRequest` now include a `metadata` map so callers can forward tracing identifiers (for example `trace_id` and `parent_span_id`) to specialist handlers.

  `@agentic-payments/app-framework` capability handlers now receive `conversationSeedId` and `metadata` on `onCapability` events.

## 4.1.2

### Patch Changes

- #860 `f49a75f` Thanks [@miguel-nascimento](https://github.com/miguel-nascimento)! - Add specialist proposal metadata propagation for concierge fan-out.

  `GetBulkAgentProposalsRequest` and `AppServiceRequest.ProposalsRequest` now include a `metadata` map so callers can forward tracing identifiers (for example `trace_id` and `parent_span_id`) to specialist handlers.

  `@agentic-payments/app-framework` capability handlers now receive `conversationSeedId` and `metadata` on `onCapability` events.

## 4.1.1

## 4.1.0

## 4.0.0

## 3.4.1

## 3.4.0

## 3.3.1

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

### Minor Changes

- #577 `b543e53` Thanks [@miguel-nascimento](https://github.com/miguel-nascimento)! - Embed JWT secret in APP_PRIVATE_DATA. `makeAgent` no longer requires a separate `jwtSecretBase64` parameter — the JWT secret is resolved from `opts.jwtSecret`, `process.env.JWT_SECRET`, or the embedded value in APP_PRIVATE_DATA.

## 2.1.1

## 2.1.0

### Minor Changes

- #536 `7e8cd3d` Thanks [@texuf](https://github.com/texuf)! - Add positions support to the agent webhook flow and expose a new `agent.onPositions()` handler for serving `GetAppPositions` requests.

  Add `UpdateAppSettings` RPC for partial settings updates, so changing one setting no longer requires fetching and rewriting all settings. Update `agentic-agent setup` with `--features` (for example, `--features positions`) to use the new endpoint.

## 2.0.13

## 2.0.12

### Patch Changes

- #380 `4b24817` Thanks [@miguel-nascimento](https://github.com/miguel-nascimento)! - Concierge required proto: Capabilities, ConversationSeed, ProposalRequest, and others

## 2.0.11

## 2.0.10

## 2.0.9

## 2.0.8

## 2.0.7

## 2.0.6

## 2.0.5

## 2.0.4

## 2.0.3

## 2.0.2

## 2.0.1

## 1.0.1
