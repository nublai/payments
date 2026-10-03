# @agentic-payments/proto

## 7.3.1

## 7.3.0

## 7.2.0

## 7.1.0

## 7.0.0

## 6.0.0

### Major Changes

- [#869](https://github.com/HereNotThere/chat/pull/869) [`961e84a`](https://github.com/HereNotThere/chat/commit/961e84a3c13740d5b20dfe9e079f30a37315059d) Thanks [@miguel-nascimento](https://github.com/miguel-nascimento)! - Rename specialist invocation capability field from `capabilityName`/`capability_name` to `name`.
  - `SpecialistCapabilityInvocation` now uses `name` in protobuf/TS/Go generated types.
  - `GetBulkAgentProposals` request payloads now send invocation `name` and map it through backend fan-out.
  - `@agentic-payments/app-framework` proposal processing now reads `invocation.name`.

## 5.0.0

### Patch Changes

- [#863](https://github.com/HereNotThere/chat/pull/863) [`d0cd833`](https://github.com/HereNotThere/chat/commit/d0cd83353528b42a342afe72854ceed59b9980a9) Thanks [@giuseppecrj](https://github.com/giuseppecrj)! - Add specialist proposal metadata propagation for concierge fan-out.

  `GetBulkAgentProposalsRequest` and `AppServiceRequest.ProposalsRequest` now include a `metadata` map so callers can forward tracing identifiers (for example `trace_id` and `parent_span_id`) to specialist handlers.

  `@agentic-payments/app-framework` capability handlers now receive `conversationSeedId` and `metadata` on `onCapability` events.

## 4.1.2

### Patch Changes

- [#860](https://github.com/HereNotThere/chat/pull/860) [`f49a75f`](https://github.com/HereNotThere/chat/commit/f49a75fabccc2c5b2ee03a9d5a79d618b256c9ac) Thanks [@miguel-nascimento](https://github.com/miguel-nascimento)! - Add specialist proposal metadata propagation for concierge fan-out.

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

- [#577](https://github.com/HereNotThere/chat/pull/577) [`b543e53`](https://github.com/HereNotThere/chat/commit/b543e53200f418cd51417d8a2a29cf13246346f2) Thanks [@miguel-nascimento](https://github.com/miguel-nascimento)! - Embed JWT secret in APP_PRIVATE_DATA. `makeAgent` no longer requires a separate `jwtSecretBase64` parameter — the JWT secret is resolved from `opts.jwtSecret`, `process.env.JWT_SECRET`, or the embedded value in APP_PRIVATE_DATA.

## 2.1.1

## 2.1.0

### Minor Changes

- [#536](https://github.com/HereNotThere/chat/pull/536) [`7e8cd3d`](https://github.com/HereNotThere/chat/commit/7e8cd3d20127f338d4271680280a8616f57d7d2f) Thanks [@texuf](https://github.com/texuf)! - Add positions support to the agent webhook flow and expose a new `agent.onPositions()` handler for serving `GetAppPositions` requests.

  Add `UpdateAppSettings` RPC for partial settings updates, so changing one setting no longer requires fetching and rewriting all settings. Update `agentic-agent setup` with `--features` (for example, `--features positions`) to use the new endpoint.

## 2.0.13

## 2.0.12

### Patch Changes

- [#380](https://github.com/HereNotThere/chat/pull/380) [`4b24817`](https://github.com/HereNotThere/chat/commit/4b24817e846fffd66d8280dab9b7ac614bbb3da0) Thanks [@miguel-nascimento](https://github.com/miguel-nascimento)! - Concierge required proto: Capabilities, ConversationSeed, ProposalRequest, and others

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
