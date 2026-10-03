---
module: wallet-cli
date: 2026-03-06
problem_type: integration_issue
component: swap-bridge-commands
symptoms:
  - "`tw account swap` initially failed at relayer submission with `Unauthorized` / `BAD_SIGNATURE` even though quotes and session permissions looked correct"
  - "`tw account swap --from ETH --to USDC` failed with `Simulation failed` while `USDC -> ETH` succeeded"
  - "`tw account swap --env stage` failed during quote fetch with `An error occurred while validating the request`"
  - "Bridging to Polygon required extra account readiness work before any fill could succeed"
  - "Several failure modes surfaced as generic remote errors even when the real issue was local input, permission, or environment mismatch"
root_cause: integration_contract_and_preflight_gaps
resolution_type: code_fix
severity: high
tags:
  - wallet-cli
  - swap
  - bridge
  - relay-link
  - relayer
  - erc8128
  - session-key
  - permissions
  - base
  - polygon
---

# Troubleshooting: Wallet CLI Swap/Bridge Feature Flow and Integration Gotchas

## Problem

We added `tw account swap` and `tw account bridge` on top of relay.link quotes plus Towns relayer execution. The happy path was straightforward, but real end-to-end validation exposed several cross-system failure modes:

- relay.link quote routing had to match our environment and chain model
- relayer HTTP auth had to be enabled for `wallet_sendPreparedCalls`
- session permissions had to cover both contract calls and asset outflow semantics
- bridge destinations had to be delegated and permissioned before fills would work
- some failures needed to be caught locally instead of surfacing as misleading relayer or relay.link errors

This document captures the full feature flow, the exact kinks we hit, why they happened, and the fixes that made the feature reliable.

## Feature Flow

### 1. Swap flow

For a same-chain swap, the wallet now does this:

1. Resolve the root/session keystore and decrypt the session key.
2. Resolve source chain, destination chain, token addresses, decimals, and slippage.
3. Read the sender balance locally.
4. If selling ETH, read session permissions and verify native spend permission exists for `0x0000000000000000000000000000000000000000`.
5. Request a relay.link quote.
6. Validate the quote structurally before execution:
   - at least one executable transaction step
   - no unsupported signature steps
   - valid calldata hex
   - valid decimal `value`
   - step `chainId` matches the expected source chain
7. Show the quote, optionally refresh if confirmation took too long, and cap re-confirmation attempts.
8. Flatten relay.link steps to relayer `Call[]`.
9. Submit via relayer `prepareCalls -> signTypedData -> sendPreparedCalls -> waitForBundle`.
10. Return structured result with quote metadata, bundle status, and `txHash`.

For same-chain swaps, `relayRequestId: null` is expected and not a bug. That field only matters for cross-chain bridge status polling.

### 2. Bridge flow

Bridge uses the same execution path with two additional requirements:

1. Source and destination chains must differ.
2. The destination account must already be delegated on the destination chain.
3. After source execution confirms, the CLI extracts `relayRequestId` and polls relay.link intent status until the destination fill succeeds or times out.
4. The CLI returns both source and destination tx hashes when available.

Operationally, bridging Base <-> Polygon only worked after the Polygon account was delegated and ready.

## What Went Wrong

### 1. Relayer auth was failing at `wallet_sendPreparedCalls`

### Symptom

Swap quotes succeeded, `wallet_prepareCalls` succeeded, but submission failed with:

- `Error: Unauthorized`
- or relayer auth code `BAD_SIGNATURE`

### Why it happened

This was not an on-chain router authorization problem.

The session already had wildcard call permission, which is enough to call dynamic relay routers. The failure boundary was relayer HTTP auth for `wallet_sendPreparedCalls`.

In practice:

- `ERC8128_ENABLED=false` disabled the ERC-8128 provider
- `PRIVY_ENABLED=false` disabled the Privy provider
- `AUTH_PROTECTED_METHODS` still protected `wallet_sendPreparedCalls`

So the relayer kept requiring auth for `wallet_sendPreparedCalls`, but had no valid provider path left to authenticate the request. That surfaced as `Unauthorized` / `BAD_SIGNATURE`.

### Fix

Align relayer auth configuration so protected submission methods have an enabled auth provider. The key lesson:

- disabling providers alone is not enough
- protected methods still require auth
- `AUTH_PROTECTED_METHODS=none` only “fixed” the issue by bypassing auth entirely

### Why this mattered in the wallet

We also improved wallet-side error surfacing so relayer auth failures preserve `auth_code` instead of collapsing into a generic `Unauthorized`.

That change lives in:

- `packages/wallet/src/lib/account-swap.ts`

Example behavior now:

```ts
if (error.code === -32001) {
  const authCode = extractAuthCode(error.data);
  return new AccountSwapError(
    "UNKNOWN",
    authCode ? `Unauthorized (${authCode})` : error.message,
  );
}
```

This was intentional. When the relayer sends structured failure data, the CLI should preserve it instead of forcing operators to inspect server logs first.

### 2. ETH sells failed even though wildcard call permission was present

### Symptom

- `USDC -> ETH` swap worked
- `ETH -> USDC` swap failed with `Simulation failed`

### Why it happened

Wildcard call permission is not the same thing as spend permission.

The session policy already allowed calling arbitrary router targets, but native ETH outflow is enforced separately by the account permission model through spend permission on the native token address:

- `0x0000000000000000000000000000000000000000`

So:

- router target authorization was fine
- native asset spend authorization was missing

That is why the relayer simulation failed only for ETH sells.

### Fix

We added an explicit wallet-side preflight for ETH-originating swaps:

1. read `wallet_getKeys`
2. resolve the active session key hash
3. verify a native spend permission exists
4. verify remaining spend limit is sufficient for the requested ETH amount

If the permission is missing, the CLI now fails with a targeted local error instead of a generic simulation failure.

Example:

```ts
if (!nativeSpend) {
  throw new AccountSwapError(
    "MISSING_NATIVE_SPEND_PERMISSION",
    `Session key is missing native ETH spend permission on ${input.sourceChain}.`,
  );
}
```

This was the right boundary for the error. The problem is not “relayer simulation failed”; the problem is “the session policy does not permit the requested asset outflow.”

### 3. `stage` quote requests were structurally invalid

### Symptom

`tw account swap --env stage` failed at quote fetch with:

- `Failed to get swap quote: An error occurred while validating the request`

### Why it happened

Our `stage` environment still used mainnet Base chain/token configuration:

- Base chain ID `8453`
- Base USDC mainnet address

But relay.link routing for non-prod environments was pointed at the testnet API. That produced a mismatch:

- mainnet chain and asset identifiers
- sent to a testnet quote endpoint

relay.link correctly rejected the request as invalid.

### Fix

We intentionally routed `stage` to mainnet relay.link, while keeping `dev` on the testnet relay.link API.

This matched the rest of the wallet environment model and made `stage` swaps executable without inventing a separate Base Sepolia token matrix.

### 4. Bridge success depended on destination-chain delegation

### Symptom

Before bridging to Polygon, account readiness checks showed the destination account was not delegated on Polygon.

### Why it happened

Bridge fills still land into a Towns account on the destination chain. If that account does not exist or is not delegated there yet, the bridge flow is not actually ready end to end.

### Fix

Delegate the account on Polygon first, then bridge.

This became an explicit operational prerequisite:

- before any bridge test, confirm destination-chain delegation readiness
- do not treat “source execution succeeded” as end-to-end bridge success

### 5. Generic remote errors were hiding local or caller-side mistakes

### Symptom

Several failures were being reported through the wrong error channel:

- invalid user slippage was treated like relay.link returned an invalid response
- missing native spend looked like relayer simulation failure
- auth failures lost relayer `auth_code`
- malformed step calldata could have reached execution if not validated

### Why it happened

The initial implementation leaned too much on remote-system error surfaces:

- relay.link errors
- relayer simulation errors
- generic unknown errors

That made diagnosis harder because the real problem was often local validation, not a remote service failure.

### Fix

We moved the logic to the correct boundary:

- caller validation stays local and throws plain/local errors
- relay.link response validation is reserved for actual relay.link payload defects
- relayer JSON-RPC failures preserve structured details like `cause` and `auth_code`

Concrete examples:

1. `slippagePercentToBps()` now throws plain `Error` for invalid user input instead of `RelayLinkError('INVALID_RESPONSE', ...)`.
2. ETH native spend is checked before relayer execution.
3. Quote chain mismatches are rejected before step flattening.
4. Relayer auth and simulation details are surfaced through `AccountSwapError`.

This is why the code moved away from using “relayer/relay-link style” errors everywhere. The error type should reflect who is actually wrong:

- user input
- wallet preflight
- relay.link response
- relayer submission

### 6. Quote safety and refresh logic needed hardening

### Symptom

The initial implementation was vulnerable to:

- accepting unvalidated step calldata
- trusting remote step `chainId` without checking it against the source chain
- hanging forever on relay.link fetches
- re-confirming forever if quotes kept drifting
- swallowing non-ENOENT keystore errors via a bare catch

### Fix

We hardened the feature in five places:

1. Added relay.link fetch timeouts.
2. Validated step calldata as hex, validated decimal `value`, and validated positive integer `chainId`.
3. Rejected relay quotes whose executable calls target the wrong chain.
4. Capped re-confirmation retries at three attempts.
5. Narrowed session fallback logic so only missing-file errors use `session.json` fallback.

These changes turned several “trust and hope” assumptions into explicit checks.

## Working Solution

The feature is now reliable when all of these conditions are true:

1. The source account is delegated and funded.
2. The session key has:
   - wildcard call permission for dynamic router targets
   - ERC-20 spend permission for token-originating swaps/bridges
   - native spend permission for ETH-originating swaps
3. The destination chain is delegated before bridging.
4. The relayer has a valid auth provider configuration for protected submission methods.
5. The selected wallet environment routes quotes to the correct relay.link API.

## Verification That Closed the Loop

We validated the feature with live CLI runs:

- same-chain Base swap: `USDC -> ETH`
- same-chain Base swap: `ETH -> USDC` after granting native spend
- Base -> Polygon bridge
- Polygon -> Base bridge
- destination balance checks after bridging
- stage relayer auth diagnosis and fix

We also locked the code with targeted tests for:

- missing native ETH spend permission
- quote source-chain mismatch
- repeated quote drift
- relayer auth code surfacing
- relay.link invalid calldata rejection
- relay.link timeout signal presence

## Prevention

When touching swap/bridge again, use this checklist:

1. Test both directions of every token pair you claim to support.
   - `token -> ETH` and `ETH -> token` are not permission-equivalent.

2. Separate call permission from spend permission in your mental model.
   - wildcard call permission does not imply native or ERC-20 spend permission.

3. Validate quote payloads before signing anything.
   - `to`, `data`, `value`, `chainId`, request ID.

4. Preserve structured relayer failure data.
   - especially `auth_code` and simulation `cause`.

5. Confirm environment routing with live requests.
   - `prod`, `stage`, and `dev` are only labels until you verify the actual relay.link base URL, relayer URL, RPC URL, and chain IDs.

6. Treat bridge readiness as a two-chain concern.
   - source readiness is not enough; destination delegation must exist first.

7. Keep local validation errors local.
   - do not mislabel user input or wallet preflight failures as relay.link response failures.

