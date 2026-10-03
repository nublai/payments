---
module: relayer-cli
date: 2026-02-19
problem_type: integration_issue
component: tooling
symptoms:
  - "`relayer account send` returned `Bundle ended in status 400 (reverted)` despite relayer logging transaction finalized"
  - "`wallet_getCallsStatus` showed intent errors like `VerificationError()`, `UnauthorizedCall(...)`, and `NoSpendPermissions()`"
  - "After local chain restarts, keystore state looked complete but on-chain behavior was inconsistent until re-created"
root_cause: missing_permission
resolution_type: code_fix
severity: high
tags: [relayer-cli, account-send, eip7702, session-key, permissions, anvil]
---

# Troubleshooting: `relayer account send` Simulation/Revert Failures

## Problem

`relayer account send` failed in local dev with either simulation failures or on-chain reverts even after account creation. The relayer could report a confirmed transaction while the intent still failed.

## Environment

- Module: relayer-cli
- Affected Component: CLI-to-relayer integration for `account send`
- Date: 2026-02-19

## Symptoms

- CLI output:
  - `Account send failed [SEND_FAILED]: Bundle ended in status 400 (reverted).`
  - `Account send failed [UNKNOWN]: Simulation failed`
- Relayer worker logs could still show:
  - `transaction finalized ... status:"confirmed"`
- `wallet_getCallsStatus` included intent-level errors (`intent_error`), not just transaction-level status.

## What Didn't Work

**Attempted Solution 1:** Retry send after successful account create.

- **Why it failed:** Root issue was not transient; intent authorization and permission model were mismatched.

**Attempted Solution 2:** Assume selector `0xe0e0e0e0` allowed all calls.

- **Why it failed:** In `GuardedExecutor`, `0xe0e0e0e0` is empty-calldata selector, not wildcard selector.

**Attempted Solution 3:** Send with raw typed-data signature from session key.

- **Why it failed:** Authorized keys require wrapped signatures (`signature + keyHash + prehashFlag`) for key-hash-based validation.

## Solution

Implemented four coordinated fixes:

1. **Fail fast on missing args before password prompt**

- `account send` now validates `<amount> <recipient>` before requesting password.

2. **Use authorized-key signature format**

- Wrap session signature before `sendPreparedCalls` using relayer-client helpers.

3. **Pass explicit nonce and session key in prepare**

- Read `getNonce(0)` from account and pass `nonce` to `prepareCalls`.
- Pass `sessionKey` to `prepareCalls` for accurate simulation context.

4. **Fix default session permissions at account creation**

- Replace selector `0xe0e0e0e0` with wildcard selector `0x32323232` (all function selectors).
- Add default `spend` permission for USDC on known chains (`period: forever`, max limit) so token transfers are allowed.

### Key code changes

```ts
// account-send: sign + wrap
const rawSignature = await deps.signTypedData({
  privateKey: sessionPrivateKey,
  typedData,
});
const keyHash = computeKeyHash("secp256k1", encodeSecp256k1Key(sessionAddress));
const signature = wrapSignature(rawSignature, keyHash);
```

```ts
// account-send: explicit nonce + sessionKey during prepare
const nonce = await deps.readNonce({ network, account: sender });
await client.prepareCalls({ from: sender, calls, chainId, nonce, sessionKey });
```

```ts
// account-create: session key defaults
permissions: [
  { type: "call", to: ANY_TARGET, selector: "0x32323232" },
  { type: "spend", token: USDC_ADDRESS, limit: MAX_UINT256, period: "forever" },
];
```

## Why This Works

1. **Transaction success != intent success**: relayer status 400/500 indicates intent-level failure even when tx is mined.
2. **Authorized session keys need wrapped signatures**: raw signatures can fail verification.
3. **Permission model is strict**:
   - `0xe0e0e0e0` only covers empty calldata.
   - ERC20 transfer requires appropriate call/spend authorization.
4. **Nonce/session context matters for prepare/simulation**: explicit values remove ambiguity and stale simulation assumptions.

## Prevention

- Always inspect `intent_error` via `wallet_getCallsStatus` when bundle status is 400/500.
- Keep account-create defaults aligned with intended day-to-day calls (call + spend permissions).
- Treat local chain restart as state reset; recreate/delegate/fund accounts after restart.
- Add integration checks in CLI tests for:
  - wrapped signature submission,
  - nonce propagation,
  - sessionKey propagation,
  - permission defaults for send flows.

## Related Issues

No related issues documented yet.
