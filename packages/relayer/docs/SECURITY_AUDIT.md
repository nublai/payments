# Relayer Security Audit - Vulnerability Report

**Date**: 2026-01-29
**Scope**: Relayer Cloudflare Worker
**Auditor**: Claude Code (audit-context-building skill)

---

## Executive Summary

This report documents security findings from a deep audit of the Relayer codebase. The relayer processes signed blockchain intents and relays them for execution, handling gas management, nonce allocation, and transaction broadcasting.

**Finding Summary**:
| Severity | Count | Fixed |
|----------|-------|-------|
| Critical | 0 | - |
| High | 0 | - |
| Medium | 2 | 2 |
| Low | 4 | 4 |
| Informational | 2 | 0 |

No critical or high-severity vulnerabilities were identified. The codebase demonstrates solid security practices around atomicity, nonce management, and key handling. All medium and low severity findings have been fixed. Two informational findings remain as documentation notes.

---

## Findings

### F-1: validatePaymentAmount Function Never Called

**Severity**: Low
**Status**: Fixed
**Location**: `src/services/fees.ts:141-143`, `src/rpc/methods/prepareCalls.ts`

#### Description

The `validatePaymentAmount` function exists but is never invoked anywhere in the codebase:

```typescript
// src/services/fees.ts:141-143
export function validatePaymentAmount(
  paymentAmount: bigint,
  paymentMaxAmount: bigint,
): boolean {
  return paymentAmount <= paymentMaxAmount;
}
```

The calculated `paymentAmount` from `calculatePaymentAmount()` is used directly without validating it against the user's `paymentMaxAmount`.

#### Impact

While on-chain validation enforces `paymentAmount <= paymentMaxAmount`, the off-chain validation gap means:

1. Relayer may broadcast transactions that will predictably revert
2. Wasted gas on invalid transactions
3. Poor user experience from failed transactions

#### Recommendation

Either:

1. Call `validatePaymentAmount` before broadcasting intents
2. Remove the unused function to avoid confusion

---

### F-2: Quote TTL Not Validated Before Execution

**Severity**: Medium
**Status**: Fixed
**Location**: `src/rpc/methods/prepareCalls.ts`, `src/rpc/methods/sendPreparedCalls.ts`

#### Description

In `handlePrepareCalls`, a TTL is set on the quote:

```typescript
// src/rpc/methods/prepareCalls.ts
const ttl = Math.floor(Date.now() / 1000) + feeConfig.quoteTtlSeconds;
const signedQuotes: SignedQuotes = {
  quotes: [quote],
  signature: "0x", // Relay signature - placeholder for now
  ttl,
};
```

However, `handleSendPreparedCalls` does NOT validate this TTL before execution. A client could submit a quote hours or days after preparation, when gas prices have changed significantly.

#### Impact

- **Stale Gas Estimates**: Gas prices fluctuate. An old quote may have `maxFeePerGas` far below current market rates, causing transaction failure or extended pending time.
- **Economic Risk**: If gas prices dropped significantly, the relayer pays more than necessary per the old quote (though capped by user's `paymentMaxAmount`).

#### Proof of Concept

1. Call `wallet_prepareCalls` when gas is 1 gwei
2. Wait 24 hours until gas is 100 gwei
3. Call `wallet_sendPreparedCalls` with the stale context
4. Transaction broadcasts with 1 gwei estimate, fails or waits indefinitely

#### Recommendation

Add TTL validation in `handleSendPreparedCalls`:

```typescript
const currentTime = Math.floor(Date.now() / 1000);
if (context.signedQuotes.ttl < currentTime) {
  throw new RpcError(RpcErrorCode.INVALID_PARAMS, "Quote expired");
}
```

---

### F-3: Quote Signature is Placeholder (Not Implemented)

**Severity**: Medium
**Status**: Fixed
**Location**: `src/rpc/methods/prepareCalls.ts`

#### Description

The quote signature is hardcoded to `'0x'`:

```typescript
const signedQuotes: SignedQuotes = {
  quotes: [quote],
  signature: "0x", // Relay signature - placeholder for now
  ttl,
};
```

This signature is never validated in `handleSendPreparedCalls`.

#### Impact

Without signature validation:

1. **Quote Manipulation**: A malicious client could modify quote parameters (fees, gas estimates) after `wallet_prepareCalls` returns
2. **Bundle ID Integrity**: While `hashQuotes` creates a deterministic bundle ID, the underlying quote data could be tampered with
3. **Fee Manipulation**: Though bounded by on-chain checks, off-chain fee parameters could be altered

#### Current Mitigations

- On-chain validation enforces `paymentAmount <= paymentMaxAmount`
- Intent signature from user is verified on-chain
- Bundle ID is computed from quote hash, not raw quote data

#### Recommendation

Implement quote signing:

```typescript
// In handlePrepareCalls
const quoteDigest = hashQuotes(signedQuotes.quotes, config);
const signature = await relayerSigner.sign(quoteDigest);

// In handleSendPreparedCalls
const isValid = await verifyQuoteSignature(
  context.signedQuotes,
  relayerPublicKey,
);
if (!isValid)
  throw new RpcError(RpcErrorCode.INVALID_PARAMS, "Invalid quote signature");
```

---

### F-4: User-Supplied Nonce Accepted Without Validation

**Severity**: Low
**Status**: Fixed
**Location**: `src/services/relayer.ts:595-596`

#### Description

In `prepareIntent`, user-supplied nonces are accepted without validation:

```typescript
// src/services/relayer.ts:595-596
const nonceToUse =
  input.nonce !== undefined
    ? BigInt(input.nonce)
    : await this.nonceProvider.acquireNonce(eoa, seqKey);
```

A user can provide an arbitrary nonce value that may:

1. Be lower than the on-chain nonce (replay)
2. Be extremely high (creates nonce gap)
3. Skip sequence numbers

#### Impact

- **User Footgun**: Users providing incorrect nonces will have transactions fail
- **Nonce Gap**: High nonces create gaps that block future transactions until filled
- **No Real Security Impact**: On-chain nonce validation will reject invalid nonces anyway

#### Current Mitigations

- On-chain validation rejects replayed nonces
- This is primarily a UX concern, not a security vulnerability

#### Recommendation

Optionally validate user-supplied nonces:

```typescript
if (input.nonce !== undefined) {
  const onChainNonce = await getOnChainNonce(eoa, seqKey);
  if (BigInt(input.nonce) < onChainNonce) {
    throw new Error("Nonce already used");
  }
}
```

---

### F-5: CORS Fully Permissive

**Severity**: Low
**Status**: Fixed
**Location**: `src/index.ts:55`

#### Description

CORS is configured without any origin restrictions:

```typescript
app.use("*", cors());
```

#### Impact

Any website can make requests to the relayer API. While the relayer is designed as a public service, unrestricted CORS allows:

1. **CSRF-like attacks**: Malicious websites can trigger actions using user credentials (though relayer doesn't use cookies/sessions)
2. **Amplification**: Any website can use the relayer as a proxy for blockchain operations
3. **Monitoring blind spot**: Hard to distinguish legitimate vs malicious traffic sources

#### Current Mitigations

- Relayer doesn't use session cookies or browser credentials
- All operations require user signatures (can't be forged by malicious sites)
- Rate limiting may be applied at Cloudflare level

#### Recommendation

Consider restricting origins to known clients:

```typescript
app.use(
  "*",
  cors({
    origin: ["https://app.example", "https://staging.example"],
  }),
);
```

Or implement API key authentication for non-browser clients.

---

### F-6: Missing Atomicity Between Broadcast and Queue Enqueue

**Severity**: Low
**Status**: Fixed
**Location**: `src/durable-objects/signer.do.ts:870-886`

#### Description

After successful broadcast, the queue enqueue happens outside the atomic transaction:

```typescript
// After successful broadcast (line 870-886)
this.sql.exec(
  "UPDATE pending_transactions SET tx_hash = ? WHERE id = ?",
  txHash,
  tx.id,
);

// Queue send is outside any transaction
await this.env.MONITOR_QUEUE.send({
  txId: tx.id,
  txHash,
  signerName,
  attempt: 0,
} satisfies MonitorJob);
```

#### Impact

If queue send fails after successful broadcast:

1. Transaction is on-chain but not monitored
2. `pending_transactions` status never updates to confirmed/failed
3. Transaction appears "stuck" in relayer state
4. Signer capacity is consumed but never freed

#### Likelihood

Low - Cloudflare Queues are highly reliable. Would require:

- Queue service outage
- Network partition between Worker and Queue
- Worker crash between DB write and queue send

#### Recommendation

Implement at-least-once delivery guarantee:

```typescript
// Option 1: Cron-based recovery
// Already partially implemented via handleMaintenance stale tx cleanup

// Option 2: Write-ahead queue entry
this.ctx.storage.transactionSync(() => {
  this.sql.exec(
    "UPDATE pending_transactions SET tx_hash = ?, queue_pending = 1 WHERE id = ?",
    txHash,
    tx.id,
  );
});
// Then enqueue with retry logic
```

---

### F-7: Health Endpoint Bypasses Environment Validation

**Severity**: Informational
**Status**: Open
**Location**: `src/index.ts:39-42`

#### Description

The health endpoint skips environment validation:

```typescript
// Skip env validation for health checks
if (c.req.path === "/health") {
  return next();
}
```

#### Impact

- Health check returns success even if relayer is misconfigured
- Monitoring systems may report "healthy" when relayer can't actually process transactions
- Useful for deployment pipelines but misleading for operational monitoring

#### Recommendation

Consider a "deep health check" endpoint that validates:

- RPC_URL connectivity
- At least one signer initialized
- Database accessible

```typescript
app.get("/health/deep", async (c) => {
  // Verify RPC
  // Verify signer pool
  // Return detailed status
});
```

---

### F-8: PreCall Nonce Hardcoded to seq=0

**Severity**: Informational
**Status**: Open
**Location**: `src/rpc/methods/prepareUpgradeAccount.ts`

#### Description

The preCall nonce uses a hardcoded sequence:

```typescript
const PRECALL_SEQ_KEY = 1n;
const preCallNonce = (PRECALL_SEQ_KEY << 64n) | 0n; // Always seq=0
```

#### Impact

- If account upgrade fails and retries, same nonce will be replayed
- However, EIP-7702 delegation is idempotent—re-delegating to same address is a no-op
- PreCalls are only for key initialization which is also idempotent

#### Recommendation

Low priority. Current behavior is acceptable given idempotency, but consider:

1. Documenting the intentional choice
2. Using IntentNonceDO for preCalls if retry semantics change

---

## Positive Security Observations

### Strong Patterns Identified

1. **Atomic Nonce Management**: `transactionSync` properly wraps all nonce operations
2. **Key Security**: Private keys derived on-demand, never persisted
3. **Intent Expiry Validation**: 30-second buffer protects against race conditions
4. **Nonce Recovery**: Self-healing on "nonce too low" errors via chain sync
5. **Capacity Management**: Per-signer limits prevent resource exhaustion
6. **Deterministic Routing**: Consistent EOA→signer mapping prevents conflicts

### Defense in Depth

- User signatures verified on-chain (cannot be forged)
- Payment bounded by `paymentMaxAmount` (user-set cap)
- Multiple gas buffers applied (cold storage, session key, 64/63 rule)

---

## Appendix: Files Analyzed

| File                                      | Analysis Depth        |
| ----------------------------------------- | --------------------- |
| `src/index.ts`                            | Full                  |
| `src/rpc/dispatcher.ts`                   | Full                  |
| `src/rpc/methods/prepareCalls.ts`         | Full + Micro-analysis |
| `src/rpc/methods/sendPreparedCalls.ts`    | Full                  |
| `src/rpc/methods/getCallsStatus.ts`       | Full                  |
| `src/rpc/methods/prepareUpgradeAccount.ts`| Full                  |
| `src/rpc/methods/upgradeAccount.ts`       | Full                  |
| `src/rpc/methods/verifySignature.ts`      | Full                  |
| `src/durable-objects/signer.do.ts`        | Full + Micro-analysis |
| `src/durable-objects/signer-pool.do.ts`   | Full                  |
| `src/durable-objects/intent-nonce.do.ts`  | Full + Micro-analysis |
| `src/durable-objects/bundle-status.do.ts` | Full                  |
| `src/services/relayer.ts`                 | Full                  |
| `src/services/fees.ts`                    | Full                  |
| `src/lib/pool-utils.ts`                   | Full                  |
| `src/config/index.ts`                     | Partial               |

---

## Related Documentation

- `docs/ARCHITECTURE.md` - Full system architecture and data flow analysis
- `docs/CRITICAL_PATHS.md` - Line-by-line analysis of security-critical functions
