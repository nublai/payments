import type { Address, Hex, SignedAuthorization, PublicClient } from 'viem'
import type { EthHttpSigner, SignOptions } from '@slicekit/erc8128'
import { INTENT_TYPES as CANONICAL_INTENT_TYPES } from '@nubl/relayer/rpc/schema/intentTypes'

// Re-export viem's SignedAuthorization for use across packages
export type { SignedAuthorization }

// ============================================================================
// Configuration
// ============================================================================

/**
 * Minimal config for relayer actions (no rpcUrl/chainId - comes from PublicClient)
 */
export interface RelayerClientConfig {
    relayerUrl: string
    /** Optional chain ID override (used when client.chain is undefined) */
    chainId?: number
    /** Optional static bearer token for HTTP Authorization */
    authToken?: string
    /** Optional bearer token provider (resolved per request) */
    authTokenProvider?: () => Promise<string | null>
    /** Optional ERC-8128 HTTP auth signer for request-level authentication */
    authSigner?: EthHttpSigner
    /** Optional ERC-8128 signing options (used with authSigner) */
    authSignOptions?: SignOptions
}

/**
 * Extended PublicClient with relayer config attached.
 * Created by using publicClient.extend(relayerActions({...}))
 */
export type RelayerPublicClient<TClient extends PublicClient = PublicClient> = TClient & {
    relayerConfig: RelayerClientConfig
}

// ============================================================================
// Account Types
// ============================================================================

export interface Keypair {
    address: Address
    privateKey: Hex
}

export interface AccountInfo {
    owner: Address
    nonce: bigint
}

// ============================================================================
// Intent Types (Orchestrator System)
// ============================================================================

export interface Call {
    target: Address
    value: bigint
    data: Hex
}

export interface Transfer {
    token: Address
    amount: bigint
}

export interface Intent {
    eoa: Address
    calls: Call[]
    nonce: bigint
    combinedGas: bigint
    expiry: bigint // Renamed from deadline
    signature: Hex
    // PreCalls (optional)
    encodedPreCalls?: Hex[]
    // Funding (optional)
    funder?: Address
    encodedFundTransfers?: Hex[]
    funderSignature?: Hex
    // Settler (optional)
    settler?: Address
    settlerContext?: Hex
    isMultichain?: boolean
    // Payment (optional - relayer reimbursement)
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: bigint
    paymentAmount?: bigint
    paymentRecipient?: Address
    /** Payer's signature authorizing payment (required if payer != eoa for gas sponsorship) */
    paymentSignature?: Hex
    // Account implementation restriction (optional)
    supportedAccountImplementation?: Address
}

/**
 * Result of signIntent containing both the intent and metadata for sponsorship
 */
export interface SignedIntent {
    /** The signed intent ready for submission */
    intent: Intent
    /** The EIP-712 digest that was signed (for third-party payment sponsorship) */
    digest: Hex
    /** The EIP-712 typed data (for third-party payment sponsorship) */
    typedData: {
        domain: EIP712Domain
        types: typeof INTENT_TYPES
        primaryType: 'Intent'
        message: Record<string, unknown>
    }
}

/**
 * EIP-712 type definitions for Intent signing
 * Must match Orchestrator contract's INTENT_TYPEHASH and CALL_TYPEHASH:
 * "Intent(bool multichain,address eoa,Call[] calls,uint256 nonce,address payer,address paymentToken,uint256 paymentMaxAmount,uint256 combinedGas,bytes[] encodedPreCalls,bytes[] encodedFundTransfers,address settler,uint256 expiry)Call(address to,uint256 value,bytes data)"
 * Note: paymentAmount and paymentRecipient are NOT included - set by relayer
 */
export const INTENT_TYPES = CANONICAL_INTENT_TYPES

/**
 * EIP-712 type definitions for funding authorization signing
 * Must match SimpleFunder contract's FUNDING_TYPEHASH and TRANSFER_TYPEHASH
 */
export const FUNDING_TYPES = {
    FundingAuthorization: [
        { name: 'digest', type: 'bytes32' },
        { name: 'transfers', type: 'Transfer[]' },
    ],
    Transfer: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
    ],
} as const

// ============================================================================
// API Request Types
// ============================================================================

/** Request to create an EIP-7702 delegated account (legacy - now uses two-step RPC flow) */
export interface CreateAccountRequest {
    accountAddress: Address
    signerKey: Hex
}

/** Request to prepare an intent for signing */
export interface PrepareIntentRequest {
    eoa: Address
    calls: {
        target: Address
        value: string
        data: Hex
    }[]
    // Optional overrides
    nonce?: string
    seqKey?: string
    expiry?: string // Renamed from deadline
    // PreCalls (optional)
    encodedPreCalls?: Hex[]
    // Funding (optional)
    funder?: Address
    encodedFundTransfers?: Hex[]
    // Settler (optional)
    settler?: Address
    // Payment (optional)
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: string
}

/** Request to execute a single intent */
export interface ExecuteIntentRequest {
    eoa: Address
    calls: {
        target: Address
        value: string
        data: Hex
    }[]
    nonce: string
    combinedGas: string
    expiry: string // Renamed from deadline
    signature: Hex
    // PreCalls (optional)
    encodedPreCalls?: Hex[]
    // Funding (optional)
    funder?: Address
    encodedFundTransfers?: Hex[]
    funderSignature?: Hex
    // Settler (optional)
    settler?: Address
    settlerContext?: Hex
    isMultichain?: boolean
    // Payment (optional - relayer reimbursement)
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: string
    paymentAmount?: string
    paymentRecipient?: Address
    /** Payer's signature authorizing payment (required if payer != eoa for gas sponsorship) */
    paymentSignature?: Hex
    // Account implementation restriction (optional)
    supportedAccountImplementation?: Address
}

/** Request to execute a batch of intents */
export interface BatchIntentsRequest {
    intents: ExecuteIntentRequest[]
}

// ============================================================================
// API Response Types
// ============================================================================

export interface CreateAccountResponse {
    success: boolean
    accountAddress?: Address
    /** Transaction hash of the delegation tx (only present when success=true) */
    txHash?: Hex
    error?: string
}

/** EIP-712 domain */
export interface EIP712Domain {
    name: string
    version: string
    chainId: number
    verifyingContract: Address
}

export interface PrepareIntentResponse {
    success: boolean
    typedData?: {
        domain: EIP712Domain
        types: typeof INTENT_TYPES
        primaryType: 'Intent'
        message: {
            multichain: boolean
            eoa: Address
            calls: { to: Address; value: string; data: Hex }[]
            nonce: string
            payer: Address
            paymentToken: Address
            paymentMaxAmount: string
            combinedGas: string
            encodedPreCalls: Hex[]
            encodedFundTransfers: Hex[]
            settler: Address
            expiry: string
        }
    }
    nonce?: string
    combinedGas?: string
    expiry?: string // Renamed from deadline
    digest?: Hex
    error?: string
}

export interface ExecuteIntentResponse {
    success: boolean
    txHash?: Hex
    gasUsed?: string
    bundleId?: string
    error?: string
}

export interface BatchIntentsResponse {
    success: boolean
    /** Bundle IDs for each intent (for status tracking) */
    bundleIds?: string[]
    txHash?: Hex
    succeeded?: number
    failed?: number
    error?: string
}

export interface HealthResponse {
    status: 'ok' | 'error'
    chainId: number
    contracts: {
        orchestrator: Address
        simulator: Address
        account: Address
        simpleFunder?: Address
    }
    error?: string
    // Primary relayer address (first available signer)
    relayerAddress?: Address
    // Pool mode (multiple signers)
    mode?: 'single' | 'pool' | 'legacy'
    /** All signer addresses in the pool */
    signerAddresses?: Address[]
    signerCount?: number
    totalCapacity?: number
    totalPending?: number
}

export interface GetNonceResponse {
    success: boolean
    nonce?: string
    error?: string
}

export interface FunderBalanceResponse {
    success: boolean
    funder?: Address
    sponsor?: Address
    balance?: string
    balanceEth?: string
    error?: string
}

export interface CapabilitiesResponse {
    success: boolean
    version?: string
    chainId?: number
    relayerAddress?: Address
    contracts?: {
        orchestrator: Address
        simulator: Address
        /** EIP-7702 delegation target (accountProxy) */
        accountProxy: Address
        simpleFunder?: Address
    }
    capabilities?: {
        accountCreation: boolean
        intentExecution: boolean
        simulation: boolean
        prepare: boolean
        statusTracking: boolean
        batchExecution: boolean
    }
    pool: {
        signerCount: number
        totalCapacity: number
        totalPending: number
        availableCapacity: number
        signers: Array<{
            index: number
            address: string | null
            balance: string | null
            capacity: number
            pending: number
            paused: boolean
        }>
    }
    error?: string
}

/**
 * Bundle status response
 *
 * Status codes:
 * - 100: Pending - still waiting for confirmation
 * - 200: Confirmed - intent executed successfully
 * - 300: Failed - tx never submitted/mined (offchain failure)
 * - 400: Reverted - tx mined but intent failed on-chain
 * - 500: PartiallyReverted - some intents in bundle failed
 * - 404: NotFound - bundle ID not found
 */
export interface BundleStatusResponse {
    success: boolean
    id?: string
    status?: 'pending' | 'confirmed' | 'failed' | 'reverted' | 'not_found'
    statusCode?: number
    receipt?: {
        transactionHash: Hex
        blockNumber: string
        gasUsed: string
        status: 'success' | 'reverted'
        /** Intent execution error (bytes4 selector, e.g., 0x9054c912 for ExceededSpendLimit) */
        intentError?: Hex
    }
    submittedAt?: number
    confirmedAt?: number
    error?: string
}
