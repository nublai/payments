/**
 * Pool Types
 *
 * Type definitions for the SignerDO and SignerPoolDO components.
 */

import type { Address, Hex, SignedAuthorization } from 'viem'

/**
 * Intent struct matching ICommon.Intent from the Orchestrator contract
 * Note: Numeric fields use string | bigint because:
 * - Strings are used for JSON serialization (sent to SignerDO)
 * - BigInts are used for contract encoding (in SignerDO)
 */
export interface IntentStruct {
    // EIP-712 Fields (JSON-RPC format)
    eoa: Address
    calls: { to: Address; value: string | bigint; data: Hex }[]
    nonce: string | bigint
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: string | bigint
    combinedGas: string | bigint
    encodedPreCalls?: Hex[]
    encodedFundTransfers?: Hex[]
    settler?: Address
    expiry: string | bigint
    // Additional Fields (not in EIP-712)
    isMultichain?: boolean
    funder?: Address
    funderSignature?: Hex
    settlerContext?: Hex
    paymentAmount?: string | bigint
    paymentRecipient?: Address
    signature: Hex
    paymentSignature?: Hex
    supportedAccountImplementation?: Address
}

/**
 * Transaction types supported by the relayer pool
 */
export type RelayTransactionType = 'create-account' | 'execute-intent' | 'batch-execute-intent'

/**
 * Base transaction fields
 */
interface BaseRelayTransaction {
    id: string
    type: RelayTransactionType
}

/**
 * PreCall for account initialization (key authorization)
 */
export interface PreCallData {
    eoa: Address
    executionData: Hex
    nonce: string
    signature: Hex
}

/**
 * Create account transaction - EIP-7702 delegation
 */
export interface CreateAccountTransaction extends BaseRelayTransaction {
    type: 'create-account'
    accountAddress: Address
    ownerAddress: Address
    authorization: SignedAuthorization
    /** Optional preCall for key initialization during upgrade */
    preCall?: PreCallData
}

/**
 * Execute intent transaction - Orchestrator.execute()
 */
export interface ExecuteIntentTransaction extends BaseRelayTransaction {
    type: 'execute-intent'
    intent: IntentStruct
}

/**
 * Batch execute intent transaction - Orchestrator.execute(bytes[])
 * Used for batching multiple intents into a single transaction
 */
export interface BatchExecuteIntentTransaction extends BaseRelayTransaction {
    type: 'batch-execute-intent'
    intents: IntentStruct[]
}

/**
 * Union type for all relay transactions
 */
export type RelayTransaction =
    | CreateAccountTransaction
    | ExecuteIntentTransaction
    | BatchExecuteIntentTransaction

/**
 * Capacity information returned by SignerDO
 */
export interface CapacityInfo {
    /** Number of additional transactions this signer can handle */
    capacity: number
    /** Number of pending transactions */
    pending: number
    /** Signer's address */
    address: Hex | null
    /** Current balance in wei (as string for JSON serialization) */
    balance?: string
    /** Whether the signer is paused (low balance or manual pause) */
    paused?: boolean
    /** Whether there was an error getting capacity */
    error?: boolean
}

/**
 * Extended capacity info with signer index (used by pool)
 */
export interface IndexedCapacityInfo extends CapacityInfo {
    index: number
}

/**
 * Result of sending a transaction via SignerDO
 */
export interface SendResult {
    /** Transaction hash */
    txHash: Hex
    /** Nonce used for the transaction */
    nonce: number
    /** Address of the signer that sent the transaction */
    signer: Hex
    /** Name of the signer DO (e.g., "signer-31337-0") */
    signerName: string
}

/**
 * Job for the transaction monitor queue
 */
export interface MonitorJob {
    type: 'monitor'
    /** Internal transaction ID */
    txId: string
    /** On-chain transaction hash */
    txHash: Hex
    /** DO name for routing (e.g., "signer-31337-0"), NOT the stringified DO ID */
    signerName: string
    /** Chain ID for receipt polling */
    chainId: number
    /** Number of check attempts so far */
    attempt: number
}

/**
 * Pending transaction record stored in SignerDO SQLite
 */
export interface PendingTransaction {
    id: string
    txHash: Hex
    nonce: number
    sentAt: number
    status: 'pending' | 'replacing' | 'confirmed' | 'failed' | 'stuck' | 'abandoned'
}

/**
 * Signer state stored in SignerDO SQLite
 */
export interface SignerState {
    address: Hex
    chainId: number
    derivationIndex: number
    nonce: number
    paused: boolean
    initialized: boolean
    balanceWei: string
    lastBalanceCheck: number
}

/**
 * Result of maintenance operation
 */
export interface MaintenanceResult {
    /** Per-signer maintenance results */
    signers: SignerMaintenanceResult[]
}

/**
 * Result of maintenance for a single signer
 */
export interface SignerMaintenanceResult {
    index: number
    address: Hex
    staleTransactions: number
    confirmedTransactions: number
    failedTransactions: number
    stuckTransactions: number
    /** F-6 Fix: Transactions re-queued after failed queue send */
    requeuedTransactions?: number
    balance: string
    paused: boolean
    gasRefillAttempted?: boolean
    gasRefillSuccess?: boolean
    gasRefillAmount?: string // wei
    gasRefillTxHash?: string
}

/**
 * Pool configuration derived from environment
 */
export interface PoolConfig {
    /** Number of signers in the pool */
    signerCount: number
    /** Maximum pending transactions per signer */
    maxPendingPerSigner: number
    /** Maximum total pending transactions across all signers */
    maxPendingTotal: number
    /** Minimum signer balance in wei before auto-pause */
    minSignerBalance: bigint
}

/**
 * Error codes returned by SignerDO
 */
export const SignerErrorCode = {
    CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
    NOT_INITIALIZED: 'NOT_INITIALIZED',
    BROADCAST_FAILED: 'BROADCAST_FAILED',
    PAUSED: 'PAUSED',
    INTENT_EXPIRED: 'INTENT_EXPIRED',
} as const

export type SignerErrorCode = (typeof SignerErrorCode)[keyof typeof SignerErrorCode]

/**
 * Structured error response from SignerDO
 */
export interface SignerError {
    error: string
    code?: SignerErrorCode
    /** False only when the signer returned before eth_sendRawTransaction. */
    broadcastAttempted?: boolean
}

/**
 * Union type for all queue jobs
 */
export type QueueJob = MonitorJob
