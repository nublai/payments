# Relayer - Architecture Guide

## 1. System Overview

### Purpose

Relayer is a Cloudflare Worker that processes signed blockchain intents and relays them for execution. It abstracts away gas management and nonce handling—users sign intents describing what they want, and the relayer handles how to execute it.

### Key Actors

| Actor                          | Trust Level       | Entry Points                             |
| ------------------------------ | ----------------- | ---------------------------------------- |
| **End Users**                  | Untrusted         | JSON-RPC endpoint (`POST /`)             |
| **Relayer Signers**            | Fully Trusted     | HD-derived from `RELAYER_MNEMONIC`       |
| **On-Chain Contracts**         | Partially Trusted | Orchestrator, Account, SimpleFunder |
| **Cloudflare Workers Runtime** | Trusted           | Queue consumer, cron scheduler           |

### Technology Stack

- **Runtime**: Cloudflare Workers (V8 isolate)
- **Framework**: Hono (HTTP router)
- **State Management**: Durable Objects with SQLite storage
- **Key Derivation**: BIP32/BIP39 (scure/bip32, scure/bip39)
- **Blockchain Interaction**: Viem
- **Queue**: Cloudflare Queues (transaction monitoring)

---

## 2. Architecture Overview

### Entry Points (src/index.ts)

```
HTTP POST / → dispatch() → Method Handlers → Durable Objects
HTTP GET /health → Simple health check (bypasses env validation)
Queue Consumer → handleQueue() → SignerDO.handleFinalized()
Cron → handleScheduled() → SignerPoolDO.handleMaintenance()
```

### Durable Object Hierarchy

```
SignerPoolDO (pool-{chainId})     ← Stateless coordinator
    ├── SignerDO (signer-{chainId}-0)    ← Individual signer #0
    ├── SignerDO (signer-{chainId}-1)    ← Individual signer #1
    └── ...

BundleStatusDO (bundle-status-{chainId})  ← Bundle tracking
IntentNonceDO ({eoa.toLowerCase()})        ← Per-account nonce management
```

### Request Flow

```
1. wallet_prepareCalls
   └── RelayerService.prepareIntent() → simulate → allocate nonce → build typed data

2. wallet_sendPreparedCalls
   └── SignerPoolDO.sendTransaction()
       └── SignerDO.sendTransaction() → atomic nonce → sign → broadcast
           └── MONITOR_QUEUE → poll receipt → SignerDO.handleFinalized()

3. wallet_getCallsStatus
   └── BundleStatusDO.get_bundle_status() → SignerDO.getTxStatus()
```

---

## 3. Critical Data Flows

### 3.1 Intent Preparation Flow (wallet_prepareCalls)

**Entry**: `src/rpc/methods/prepareCalls.ts`

**Steps**:

1. Parse and validate params (from, calls, chain_id)
2. Create IntentNonceProvider from Durable Object namespace
3. Call `RelayerService.prepareIntent()`:
   - Acquire nonce from IntentNonceDO (or chain fallback)
   - Simulate intent execution via Simulator contract
   - Apply gas buffers (cold storage, session key, 64/63 rule)
   - Build EIP-712 typed data for Intent struct
4. Estimate fees using EIP-1559 fee history
5. Build Quote and SignedQuotes structure
6. Return context with quote, digest, typedData for client signing

**Key Invariants**:

- Nonce is atomically acquired (IntentNonceDO uses transactionSync)
- Expiry defaults to 1 hour from now
- Combined gas has multiple safety buffers applied

### 3.2 Intent Submission Flow (wallet_sendPreparedCalls)

**Entry**: `src/rpc/methods/sendPreparedCalls.ts`

**Steps**:

1. Parse context and signature
2. Compute bundle ID from quote hash (deterministic via hashQuotes)
3. Build IntentStruct from params (buildIntentFromParams)
4. Send via SignerPoolDO → SignerDO routing:
   - Per-EOA routing: `keccak256(eoa) % signerCount`
   - Fallback to highest-capacity signer if preferred is at capacity
5. SignerDO atomic transaction:
   - Check paused/capacity
   - Increment nonce atomically (SQLite transaction)
   - Sign and broadcast via viem
   - Retry once on nonce errors (sync from chain)
6. Store bundle mapping in BundleStatusDO
7. Enqueue MonitorJob for receipt polling

**Key Invariants**:

- Nonce allocation is atomic within SignerDO
- Intent expiry is validated with 30s buffer before broadcast
- Failed broadcasts trigger nonce rollback

### 3.3 Transaction Monitoring Flow

**Entry**: `src/index.ts:151-197`

**Steps**:

1. Queue consumer receives MonitorJob
2. Fetch transaction receipt via `eth_getTransactionReceipt`
3. If confirmed/failed: notify SignerDO via `/finalized` endpoint
4. If pending: retry with exponential backoff (max 60s)

**Key Invariants**:

- Only modifies pending_transactions status after confirmation
- Uses signerName (not stringified DO ID) for routing

### 3.4 Nonce Management

**Two separate nonce systems**:

1. **Signer Nonce** (SignerDO.signer_state.nonce)
   - On-chain transaction nonce for relayer signers
   - Managed atomically via SQLite transactionSync
   - Self-heals on "nonce too low" errors by syncing from chain

2. **Intent Nonce** (IntentNonceDO)
   - 2D nonce: `(seqKey:192 | seq:64)`
   - Per-account (keyed by EOA address)
   - Used for intent replay protection

---

## 4. State Management

### 4.1 SignerDO State (SQLite)

**Tables**:

```sql
signer_state:
  - address (derived from mnemonic)
  - chain_id, derivation_index
  - nonce (on-chain nonce tracker)
  - paused, initialized
  - balance_wei, last_balance_check

pending_transactions:
  - id (internal tx ID, used for bundleId mapping)
  - tx_hash, nonce, sent_at
  - status: 'pending' | 'confirmed' | 'failed' | 'stuck'
```

**Initialization**:

- Self-initializing on first request
- Parses DO name: `signer-{chainId}-{derivationIndex}`
- Derives key via BIP32 path `m/44'/60'/0'/0/{index}`
- Fetches on-chain nonce for initial state

### 4.2 IntentNonceDO State (SQLite)

```sql
nonces:
  - seq_key (192-bit, string representation)
  - seq (64-bit counter, string representation)
```

**Nonce Format**:

```
Full nonce = (seqKey << 64) | seq
```

### 4.3 BundleStatusDO State (SQLite)

```sql
bundle_transactions:
  - bundle_id → tx_id mapping
  - signer_name for routing

pending_bundles / finished_bundles:
  - For multichain bundle tracking (future)
```

---

## 5. Security-Critical Functions

### 5.1 SignerDO.sendTransaction

**File**: `src/durable-objects/signer.do.ts:714-894`

**Critical Operations**:

1. Atomic nonce acquisition in transactionSync
2. Intent expiry validation with buffer
3. Nonce error recovery (sync from chain, retry once)
4. Private key derivation (on-demand, never persisted)

**Trust Assumptions**:

- Mnemonic is secret and secure
- SQLite transactionSync provides atomicity
- On-chain nonce is authoritative after broadcast failure

### 5.2 SignerDO.signAndBroadcast

**File**: `src/durable-objects/signer.do.ts:899-1042`

**Transaction Types**:

1. `create-account`: EIP-7702 delegation with optional preCall
2. `execute-intent`: Single intent via Orchestrator.execute(bytes)
3. `batch-execute-intent`: Multiple intents via Orchestrator.execute(bytes[])

**Critical Operations**:

- Sets `paymentRecipient` (FEE_RECIPIENT or signer address)
- Encodes Intent struct matching ICommon.Intent
- Validates intent expiry before broadcast

### 5.3 IntentNonceDO.acquireNonce

**File**: `src/durable-objects/intent-nonce.do.ts:135-162`

**Atomicity**:

```javascript
const result = this.ctx.storage.transactionSync(() => {
  // Get current value (or 0 if not exists)
  // Increment and upsert
  return currentSeq;
});
```

**Key Invariants**:

- transactionSync ensures no race conditions
- seqKey must be in range [0, 2^192)
- Returns `(seqKey << 64) | seq`

### 5.4 hashQuotes

**File**: `src/rpc/methods/shared/calls-helpers.ts`

**Purpose**: Compute deterministic bundle ID from signed quotes

**Critical**: Must match Rust implementation exactly for bundle ID consistency

**Components hashed**:

- chain_id (32 bytes)
- intent digest (EIP-712 hashTypedData)
- extra_payment, eth_price (32 bytes each)
- payment_token_decimals (1 byte)
- tx_gas, maxFeePerGas, maxPriorityFeePerGas (32 bytes each)
- orchestrator address (20 bytes)
- deficit flag (1 byte)

### 5.5 verifySignature (wallet_verifySignature)

**File**: `src/rpc/methods/verifySignature.ts`

**Algorithm**:

1. Check account delegation (EIP-7702 bytecode)
2. Fetch superAdmin keys via getKeys()
3. Compute ERC-1271 replay-safe digest
4. Wrap signature with keyHash + prehash
5. Call unwrapAndValidateSignature for each key
6. Return first valid result

**Trust Assumptions**:

- Account.unwrapAndValidateSignature is authoritative
- Only superAdmin keys are checked

---

## 6. Trust Boundaries

### 6.1 User Input → Relayer

**Untrusted inputs**:

- `from` address (validated as address format only)
- `calls` array (to, data, value)
- `signature` (verified on-chain)
- `context` (contains quote data)

**Validation gaps**:

- No balance pre-check before intent submission
- No simulation re-run before execution
- Quote TTL is client-enforced, not server-enforced

### 6.2 Relayer → On-Chain

**Trusted**:

- Orchestrator contract behavior
- Account signature validation
- SimpleFunder gas refill mechanics

**Potential issues**:

- Orchestrator reverts don't prevent gas consumption
- Intent expiry is checked before broadcast but could race

### 6.3 Durable Object → Durable Object

**Communication**: HTTP fetch over internal URLs (e.g., `http://do/send`)

**Trust**: Full trust within same Worker deployment

**Potential issues**:

- signerName query param is used for local dev (ctx.id.name undefined)
- No authentication between DOs

---

## 7. Invariants

### System-Level Invariants

1. **Nonce Monotonicity**: SignerDO nonce only increases (except on chain sync after failure)
2. **Intent Uniqueness**: Intent nonces are unique per account per seqKey
3. **Signer Isolation**: Each EOA routes to consistent signer (hash-based)
4. **Bundle Traceability**: Every sent intent has a bundle_transactions record

### Security Invariants

1. **Key Security**: Private keys are derived on-demand, never persisted
2. **Signature Integrity**: User signatures are passed through unmodified to chain
3. **Expiry Enforcement**: Intents are rejected if within 30s of expiry
4. **Payment Protection**: paymentAmount is recomputed from the quote's gas and fee fields when a payer is set. The client-supplied paymentAmount is not collected. Quote HMAC is required outside local/dev.

### Operational Invariants

1. **Capacity Management**: Signers pause when balance < minBalance
2. **Queue Delivery**: MonitorJobs are acked only after successful status update
3. **Maintenance Idempotency**: Stale tx cleanup is idempotent

---

## 8. Potential Risk Areas

### 8.1 Nonce Race Conditions

**Risk**: Multiple concurrent requests for same EOA could get same nonce

**Mitigation**:

- Per-EOA routing ensures single signer handles an EOA
- IntentNonceDO uses transactionSync for atomicity

**Residual Risk**: If signerCount changes, EOA may route to different signer

### 8.2 Intent Expiry Races

**Risk**: Intent passes expiry check but expires before chain inclusion

**Current Buffer**: 30 seconds (configurable via INTENT_EXPIRY_BUFFER_SECONDS)

**Residual Risk**: High gas prices or network congestion could exceed buffer

### 8.3 Gas Estimation Inaccuracy

**Risk**: Simulated gas differs from actual execution

**Mitigations**:

- COLD_STORAGE_BUFFER (17,100 gas)
- SESSION_KEY_BUFFER (50,000 gas)
- 64/63 rule multiplier
- 10% additional buffer

**Residual Risk**: Session key operations may use more gas than buffer

### 8.4 Bundle ID Determinism

**Risk**: hashQuotes implementation differs from other systems

**Critical**: Must match Rust implementation exactly

**Fields**: Intent digest, fees, orchestrator, deficits

### 8.5 Queue Processing Failures

**Risk**: Queue message processed but SignerDO update fails

**Mitigation**: Message not acked until SignerDO confirms

**Residual Risk**: DO could crash between receiving and persisting

### 8.6 CORS Permissiveness

**Note**: CORS is currently permissive (`cors()` without origin restrictions)

**Risk**: Any website can call the relayer API

### 8.7 Health Endpoint Bypasses Env Validation

**File**: `src/index.ts:39-42`

```javascript
if (c.req.path === "/health") {
  return next();
}
```

**Risk**: Health check works even with misconfigured environment

---

## 9. Configuration & Secrets

### Required Secrets

- `RPC_URL`: JSON-RPC endpoint
- `RELAYER_MNEMONIC`: HD wallet mnemonic (12/24 words)
- `CHAIN_ID`: Chain ID as string

### Optional Configuration

| Variable                     | Default        | Purpose              |
| ---------------------------- | -------------- | -------------------- |
| RELAYER_COUNT                | 1              | Number of signers    |
| MAX_PENDING_PER_SIGNER       | 16             | Capacity per signer  |
| MAX_PENDING_TOTAL            | 1000           | Global backpressure  |
| MIN_SIGNER_BALANCE           | 0.01 ETH       | Auto-pause threshold |
| TARGET_SIGNER_BALANCE        | 0.01 ETH       | Refill target        |
| INTENT_EXPIRY_BUFFER_SECONDS | 30             | Rejection buffer     |
| FEE_RECIPIENT                | signer address | Fee destination      |

---

## 10. Contract Dependencies

### Orchestrator

- `execute(bytes encodedIntent)`: Single intent execution
- `execute(bytes[] encodedIntents)`: Batch execution
- `executePreCalls(address, SignedCall[])`: Key initialization

### Account

- `getNonce(seqKey)`: Read current intent nonce
- `getKeys()`: Fetch authorized keys
- `unwrapAndValidateSignature(digest, signature)`: Signature verification

### Simulator

- `simulateGasUsed(orchestrator, overrideCombinedGas, encodedIntent)`: Gas estimation

### SimpleFunder

- `pullGas(amount)`: Self-refill mechanism for signers

---

## 11. EIP-712 Type Structures

### Intent Type (INTENT_TYPEHASH)

```
Intent(
  bool multichain,
  address eoa,
  Call[] calls,
  uint256 nonce,
  address payer,
  address paymentToken,
  uint256 paymentMaxAmount,
  uint256 combinedGas,
  bytes[] encodedPreCalls,
  bytes[] encodedFundTransfers,
  address settler,
  uint256 expiry
)
Call(address to, uint256 value, bytes data)
```

### Domain

```javascript
{
  name: 'Orchestrator',
  version: '0.5.5',
  chainId: config.chainId,
  verifyingContract: config.contracts.orchestrator
}
```

---

## 12. Appendix: File Map

| File                                      | Purpose                                   |
| ----------------------------------------- | ----------------------------------------- |
| `src/index.ts`                            | Entry point, queue consumer, cron handler |
| `src/rpc/dispatcher.ts`                   | JSON-RPC routing, batch optimization      |
| `src/rpc/methods/prepareCalls.ts`         | Intent preparation method                 |
| `src/rpc/methods/sendPreparedCalls.ts`    | Intent submission method                  |
| `src/rpc/methods/getCallsStatus.ts`       | Bundle status query method                |
| `src/rpc/methods/verifySignature.ts`      | Signature verification                    |
| `src/durable-objects/signer.do.ts`        | Individual signer management              |
| `src/durable-objects/signer-pool.do.ts`   | Signer pool coordinator                   |
| `src/durable-objects/intent-nonce.do.ts`  | Per-account nonce management              |
| `src/durable-objects/bundle-status.do.ts` | Bundle tracking                           |
| `src/services/relayer.ts`                 | Simulation and preparation                |
| `src/services/fees.ts`                    | Fee estimation                            |
| `src/lib/pool-utils.ts`                   | EOA → signer routing                      |
| `src/config/index.ts`                     | Environment configuration                 |
