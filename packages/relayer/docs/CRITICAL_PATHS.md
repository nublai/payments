# Towns Relayer - Critical Code Paths

Deep analysis of security-critical functions, their invariants, and assumptions.

## 1. SignerDO.sendTransaction (Lines 714-894)

### Purpose

Atomically allocates a nonce, signs an intent, broadcasts to chain, and handles failures with recovery. This is the core path where value flows through the relayer.

### Inputs & Assumptions

| Input     | Type         | Trust Level       | Validation            |
| --------- | ------------ | ----------------- | --------------------- |
| tx.id     | string       | Internal          | None - used as DB key |
| tx.type   | enum         | Internal          | Switch statement      |
| tx.intent | IntentStruct | Partially trusted | Expiry validated      |

**Preconditions**:

- SignerDO must be initialized (checked via ensureInitialized)
- Mnemonic must be valid for key derivation
- RPC endpoint must be reachable

### Block-by-Block Analysis

**Block 1: Capacity Check (Lines 717-751)**

```typescript
const maxPending = parseInt(this.env.MAX_PENDING_PER_SIGNER ?? '16', 10)

const result = this.ctx.storage.transactionSync(() => {
    // Check paused
    const stateRows = this.sql.exec('SELECT paused FROM signer_state WHERE id = 1').toArray()
    if (stateRows[0].paused) {
        return { error: 'Signer is paused', code: 'PAUSED' }
    }

    // Check capacity
    const pending = (this.sql.exec("SELECT COUNT(*) as c FROM pending_transactions WHERE status = 'pending'").toArray()[0]?.c as number) ?? 0
    if (pending >= maxPending) {
        return { error: 'Signer at capacity', code: 'CAPACITY_EXCEEDED' }
    }
    ...
})
```

**Why here**: Must check capacity atomically with nonce acquisition to prevent over-allocation.

**Assumptions**:

1. `paused` accurately reflects signer health
2. Pending count is accurate (no orphaned entries)
3. maxPending is a reasonable limit

**Invariants**:

- Capacity check happens BEFORE nonce increment
- transactionSync ensures atomicity

**First Principles**: Why is capacity limited?

- Prevents nonce exhaustion
- Limits exposure if signer is compromised
- Allows graceful degradation under load

---

**Block 2: Atomic Nonce Acquisition (Lines 754-783)**

```typescript
const updatedRows = this.sql
  .exec(
    "UPDATE signer_state SET nonce = nonce + 1 WHERE id = 1 RETURNING nonce - 1 as acquired_nonce, address, chain_id",
  )
  .toArray();

const acquiredNonce = updatedRows[0].acquired_nonce as number;

// Insert pending transaction (tx_hash will be updated after broadcast)
this.sql.exec(
  `
    INSERT INTO pending_transactions (id, tx_hash, nonce, sent_at, status)
    VALUES (?, '', ?, ?, 'pending')
`,
  tx.id,
  acquiredNonce,
  Date.now(),
);
```

**Why here**: Must increment nonce atomically with pending record creation.

**Assumptions**:

1. SQLite nonce matches on-chain nonce
2. tx.id is unique (collision would violate PRIMARY KEY)
3. No concurrent modifications outside transactionSync

**Invariants**:

- Nonce is incremented exactly once per transaction attempt
- Pending record exists before broadcast (for tracking)

**5 Whys: Why UPDATE RETURNING?**

1. Why not separate SELECT then UPDATE? → Race condition
2. Why atomic? → Multiple requests could get same nonce
3. Why does same nonce matter? → Both txs would be rejected or replace each other
4. Why RETURNING nonce - 1? → We want the pre-increment value
5. Why not just use current nonce? → Increment must be part of same atomic op

---

**Block 3: Sign and Broadcast (Lines 795-868)**

```typescript
try {
    txHash = await this.signAndBroadcast(tx, successResult.nonce, successResult.address, successResult.chainId)
} catch (error) {
    const errorMessage = getErrorMessage(error)

    if (this.isNonceError(errorMessage)) {
        // Nonce recovery: sync from chain, retry once
        this.ctx.storage.transactionSync(() => {
            this.sql.exec('DELETE FROM pending_transactions WHERE id = ?', tx.id)
        })

        const syncedNonce = await this.syncNonceFromChain()

        const retryNonce = this.ctx.storage.transactionSync(() => {
            // Re-acquire nonce and re-insert pending
            ...
        })

        txHash = await this.signAndBroadcast(...)
    } else {
        // Non-nonce error: rollback
        this.ctx.storage.transactionSync(() => {
            this.sql.exec('DELETE FROM pending_transactions WHERE id = ?', tx.id)
            this.sql.exec('UPDATE signer_state SET nonce = nonce - 1 WHERE id = 1')
        })
        throw error
    }
}
```

**Why here**: Network I/O must be outside transaction, but errors need recovery.

**Assumptions**:

1. Nonce errors are identifiable by message patterns
2. Chain nonce is authoritative after error
3. Single retry is sufficient

**Invariants**:

- Pending record is cleaned up on failure
- Nonce is decremented if broadcast failed (non-nonce error)
- Nonce is synced from chain on nonce error (corrects drift)

**Risk Analysis**:
| Scenario | Handling | Risk |
|----------|----------|------|
| Nonce too low | Sync from chain, retry once | Could fail again if many txs pending |
| Nonce too high | Not specifically handled | Would always fail until chain catches up |
| Network timeout | Rollback nonce | Tx may have been submitted |
| RPC error | Rollback nonce | Same as timeout |

**5 Hows: How does nonce recovery work?**

1. Detect nonce error via message pattern matching
2. Delete failed pending record
3. Fetch on-chain nonce via eth_getTransactionCount(pending)
4. Update signer_state.nonce to on-chain value
5. Re-acquire nonce and retry broadcast

---

**Block 4: Post-Broadcast Cleanup (Lines 870-893)**

```typescript
// Update pending record with tx hash
this.sql.exec(
  "UPDATE pending_transactions SET tx_hash = ? WHERE id = ?",
  txHash,
  tx.id,
);

// Enqueue for monitoring
await this.env.MONITOR_QUEUE.send({
  txId: tx.id,
  txHash,
  signerName,
  attempt: 0,
} satisfies MonitorJob);

return {
  txHash,
  nonce: successResult.nonce,
  signer: successResult.address,
  signerName,
};
```

**Why here**: Only after successful broadcast.

**Assumptions**:

1. Queue send will eventually succeed
2. tx.id matches pending record

**Invariants**:

- tx_hash is populated only after successful broadcast
- MonitorJob is enqueued for every successfully broadcast tx

**Risk**: If queue send fails after broadcast, tx is orphaned (not tracked).

---

### Cross-Function Dependencies

1. **ensureInitialized()** (Line 715)
   - Must complete before any state access
   - Self-initializes from DO name + mnemonic

2. **signAndBroadcast()** (Lines 899-1042)
   - Handles transaction type dispatch
   - Validates intent expiry
   - Encodes intent to bytes

3. **syncNonceFromChain()** (Lines 375-392)
   - Called on nonce errors
   - Updates signer_state.nonce

4. **isNonceError()** (Lines 359-369)
   - Pattern matches error messages
   - Returns true for nonce-related failures

---

## 2. IntentNonceDO.acquireNonce (Lines 135-162)

### Purpose

Atomically increment and return a 2D nonce (seqKey:192 | seq:64) for intent replay protection.

### Inputs & Assumptions

| Input  | Type   | Trust Level | Validation                            |
| ------ | ------ | ----------- | ------------------------------------- |
| seqKey | bigint | Untrusted   | Range [0, 2^192) validated in fetch() |

**Preconditions**:

- seqKey has been validated in fetch() handler

### Block-by-Block Analysis

**Block 1: Transaction-Safe Increment (Lines 140-158)**

```typescript
const result = this.ctx.storage.transactionSync(() => {
  // Get current value (or 0 if not exists)
  const rows = this.sql
    .exec("SELECT seq FROM nonces WHERE seq_key = ?", key)
    .toArray();
  const currentSeq =
    rows.length > 0
      ? BigInt(String((rows[0] as Record<string, unknown>).seq))
      : 0n;
  const nextSeq = currentSeq + 1n;

  // Upsert with incremented value
  this.sql.exec(
    `
        INSERT INTO nonces (seq_key, seq) VALUES (?, ?)
        ON CONFLICT(seq_key) DO UPDATE SET seq = ?
    `,
    key,
    nextSeq.toString(),
    nextSeq.toString(),
  );

  return currentSeq;
});
```

**Why transactionSync**:

- Multiple requests could arrive concurrently
- Without atomicity, two requests could get same seq

**Assumptions**:

1. One DO instance per EOA (via idFromName)
2. transactionSync provides mutual exclusion
3. BigInt string conversion is lossless

**Invariants**:

- seq always increases for a given seqKey
- No duplicate nonces are ever returned
- Returns currentSeq (pre-increment value)

---

**Block 2: Nonce Assembly (Lines 160-162)**

```typescript
const seq = result as bigint;
return (seqKey << 64n) | seq;
```

**Why this format**:

- 2D nonce: upper 192 bits for seqKey, lower 64 bits for seq
- Allows multiple parallel operation streams per account
- Matches on-chain expectation

**Assumptions**:

1. seqKey fits in 192 bits (validated earlier)
2. seq fits in 64 bits (would overflow after 2^64 ops per seqKey)

**Risk**: No overflow protection on seq (would wrap after 2^64 increments).

---

### Security Invariants

1. **No Duplicate Nonces**: transactionSync guarantees
2. **Monotonic Increase**: seq only increments, never decrements
3. **Isolation**: One DO per EOA, no cross-account interference

---

## 3. signAndBroadcast (Lines 899-1042)

### Purpose

Dispatch by transaction type, validate preconditions, encode for chain, and broadcast.

### Block-by-Block Analysis

**Block 1: Intent Expiry Validation (Lines 952-963)**

```typescript
case 'execute-intent': {
    const bufferSeconds = parseInt(
        this.env.INTENT_EXPIRY_BUFFER_SECONDS ?? String(DEFAULT_INTENT_EXPIRY_BUFFER_SECONDS),
        10
    )
    if (isIntentExpired(tx.intent.expiry, bufferSeconds)) {
        throw new SignerDOError(
            `Intent expired. Expiry: ${tx.intent.expiry}, Current: ${Math.floor(Date.now() / 1000)}`,
            'INTENT_EXPIRED'
        )
    }
```

**Why here**: Last check before broadcast—prevents wasted gas on expired intents.

**Assumptions**:

1. System clock is reasonably accurate
2. 30s buffer accounts for network/inclusion delay
3. Intent will be included before (expiry - bufferSeconds)

**Risk**: Clock skew or high latency could cause false rejections or expired inclusions.

---

**Block 2: Payment Recipient Assignment (Lines 967-971)**

```typescript
const intentWithRecipient = {
  ...tx.intent,
  paymentRecipient: getPaymentRecipient(
    this.env.FEE_RECIPIENT,
    account.address,
  ),
};
```

**Why here**: Relayer sets payment recipient to either configured FEE_RECIPIENT or signer's own address.

**Assumptions**:

1. FEE_RECIPIENT is a valid address (if set)
2. Signer address is valid fallback
3. User consented to fees via paymentMaxAmount

**Security**: User's paymentMaxAmount caps exposure.

---

**Block 3: Intent Encoding (encodeIntentToBytes, Lines 1047-1128)**

```typescript
private encodeIntentToBytes(intent: IntentStruct): Hex {
    // Convert calls array to Call[] struct format
    const calls = intent.calls.map((call) => ({...}))

    // Encode calls as executionData
    const executionData = encodeAbiParameters([...], [calls])

    // Build Intent struct matching ICommon.Intent
    const intentForContract = {
        eoa: intent.eoa,
        executionData,
        nonce: BigInt(intent.nonce),
        // ... all other fields
    }

    // ABI-encode the full Intent struct
    return encodeAbiParameters([...], [intentForContract])
}
```

**Why this structure**:

- Must match Orchestrator's expected format
- executionData wraps calls separately
- Intent struct wraps everything

**Assumptions**:

1. ABI encoding matches contract expectation
2. All fields have correct types and defaults
3. BigInt conversion handles string/bigint inputs

**Invariants**:

- zeroAddress used for optional addresses
- '0x' used for optional bytes
- Signature is passed through unmodified

---

## 4. hashQuotes (Lines 512-635)

### Purpose

Compute deterministic bundle ID from signed quotes—must match other implementations (Rust).

### Block-by-Block Analysis

**Byte Concatenation Order**:

```
1. chain_id (32 bytes, big-endian)
2. intent digest (32 bytes, EIP-712 hash)
3. extra_payment (32 bytes)
4. eth_price (32 bytes)
5. payment_token_decimals (1 byte)
6. tx_gas (32 bytes)
7. maxFeePerGas (32 bytes)
8. maxPriorityFeePerGas (32 bytes)
9. orchestrator (20 bytes)
10. deficit flag (1 byte)
```

**Why exact ordering**:

- Deterministic ID across systems
- Same input → same bundle ID
- Client and relayer must agree

**Assumptions**:

1. Rust implementation uses identical ordering
2. Big-endian for all numeric values
3. Intent digest calculation matches

**Risk**: Any deviation causes bundle ID mismatch → status lookup fails.

---

### Intent Digest Calculation (Lines 521-583)

```typescript
const intentDigest = hashTypedData({
  domain: {
    name: "Orchestrator",
    version: "0.5.5",
    chainId: config.chainId,
    verifyingContract: config.contracts.orchestrator,
  },
  types: INTENT_TYPES,
  primaryType: "Intent",
  message: intentMessage,
});
```

**Critical**: Domain, types, and message must match exactly.

**Fields in intentMessage**:

- multichain: false
- eoa, calls, nonce
- payer, paymentToken, paymentMaxAmount
- combinedGas, encodedPreCalls, encodedFundTransfers
- settler, expiry

**Invariants**:

- Null addresses become zeroAddress
- Null arrays become empty arrays
- Numbers become BigInt

---

## 5. buildIntentFromParams (Lines 887-940)

### Purpose

Transform RPC params + context into IntentStruct for SignerDO.

### Security-Critical Decisions

**Payment Amount Logic (Lines 928-930)**:

```typescript
paymentAmount: quoteIntent.payer && quoteIntent.payer !== zeroAddress
    ? calculatedPaymentAmount
    : '0',
```

**Why**: Only charge fees when payer is specified (non-gasless mode).

**Payment Signature Logic (Lines 934-936)**:

```typescript
paymentSignature: quoteIntent.paymentSignature ??
    (quoteIntent.payer === quoteIntent.eoa ? signature : '0x'),
```

**Why**: When user pays themselves, their intent signature also authorizes payment.

**Third-party sponsorship**: Requires separate paymentSignature from sponsor.

---

## 6. Summary of Critical Invariants

### Atomicity Invariants

1. SignerDO nonce increment + pending insert is atomic
2. IntentNonceDO seq increment is atomic
3. Rollback on failure is atomic

### Ordering Invariants

1. Capacity check before nonce acquisition
2. Expiry validation before broadcast
3. Pending record before queue enqueue

### Value Invariants

1. paymentAmount <= paymentMaxAmount (enforced on-chain)
2. combinedGas includes safety buffers
3. expiry > currentTime + bufferSeconds

### State Invariants

1. Every broadcast tx has a pending record
2. Every pending record eventually becomes confirmed/failed/stuck
3. Signer nonce >= on-chain nonce (may be ahead due to pending)

---

## 7. Identified Risks

| Risk                                            | Severity | Likelihood | Location               |
| ----------------------------------------------- | -------- | ---------- | ---------------------- |
| Nonce recovery fails on second attempt          | Medium   | Low        | signer.do.ts:845-858   |
| Queue send fails after successful broadcast     | Medium   | Low        | signer.do.ts:881-886   |
| hashQuotes mismatch with Rust                   | High     | Low        | calls.ts:512-635       |
| Intent expires between validation and inclusion | Low      | Medium     | signer.do.ts:952-963   |
| seq overflow in IntentNonceDO                   | Very Low | Very Low   | intent-nonce.do.ts:157 |
| Concurrent signerCount change                   | Medium   | Very Low   | pool-utils.ts:29-30    |
