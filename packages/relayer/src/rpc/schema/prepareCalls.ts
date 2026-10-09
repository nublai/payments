import type { Address, Hex } from 'viem'

import type { IntentTypes } from './intentTypes'

/**
 * Call object in JSON-RPC format
 */
export interface RpcCall {
    to: Address
    data?: Hex
    value?: Hex
}

/**
 * Parameters for wallet_prepareCalls
 */
/**
 * EIP-7702 authorization for a user-paid first upgrade.
 * The quote HMAC covers this object. The intent digest does not.
 */
export interface PaidUpgradeAuthorization {
    contractAddress: Address
    chainId: number
    nonce: number
    signature: Hex
}

/** Key-initialization SignedCall carried inside the HMAC'd quote and the intent. */
export interface PaidUpgradePreCall {
    eoa: Address
    executionData: Hex
    nonce: string
    signature: Hex
}

export interface PaidUpgradeQuote {
    authorization: PaidUpgradeAuthorization
    preCall: PaidUpgradePreCall
}

export interface PrepareCallsParams {
    from?: Address
    chain_id: string // hex
    calls: RpcCall[]
    /** Session key public key for gas simulation accuracy */
    session_key?: Hex
    capabilities?: {
        meta?: {
            fee_payer?: Address
            fee_token?: Address
            fee_max_amount?: string
            nonce?: string
            seq_key?: string
            prepare_key?: string
            expiry?: string
            settler?: Address
            settler_context?: Hex
        }
        /**
         * Present only for a USDC-paid first EIP-7702 upgrade.
         * The relayer copies this onto the quote before the HMAC.
         */
        accountUpgrade?: PaidUpgradeQuote
    }
}

/**
 * Intent structure within a Quote
 */
export interface QuoteIntent {
    eoa: Address
    calls: { to: Address; value: string; data: Hex }[]
    nonce: string
    combinedGas: string
    expiry: string
    encodedPreCalls?: Hex[]
    funder?: Address
    encodedFundTransfers?: Hex[]
    settler?: Address
    settlerContext?: Hex
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: string
    /** Payment signature for third-party sponsorship (when payer != eoa) */
    paymentSignature?: Hex
}

/**
 * Quote for a prepared call bundle
 */
export interface Quote {
    chainId: string
    intent: QuoteIntent
    extraPayment: string
    ethPrice: string
    paymentTokenDecimals: number
    txGas: number
    nativeFeeEstimate: {
        maxFeePerGas: number
        maxPriorityFeePerGas: number
    }
    /**
     * Payment amount in fee-token units, as quoted.
     * Send ignores this field and recomputes the fee from txGas, maxFeePerGas, and nativeRate.
     */
    paymentAmount: string
    /**
     * Fee-token units per 1 native token, scaled by 1e18.
     * Set by prepareCalls and covered by the quote HMAC. Required to recompute an ERC-20 fee.
     */
    nativeRate?: string
    /**
     * Set to `session_key` only when that address is the account EOA or a live on-chain key
     * of the account. Otherwise the account EOA. Not sufficient on its own for ERC-8128.
     */
    authSigner?: Address
    orchestrator: Address
    feeTokenDeficit: string
    assetDeficits: Array<{
        address?: Address
        metadata: { name?: string; symbol?: string; decimals?: number }
        required: string
        deficit: string
    }>
    telemetry?: {
        simulationGas?: string
        combinedGas?: string
        txGas?: string
        paymentEnabled?: boolean
    }
    /**
     * User-paid first upgrade. Covered by the quote HMAC together with `intent`,
     * including `intent.encodedPreCalls`. Send rejects a different authorization
     * or pre-call.
     */
    accountUpgrade?: PaidUpgradeQuote
}

/**
 * Signed quotes with relay signature
 */
export interface SignedQuotes {
    quotes: Quote[]
    signature: Hex
    ttl: number
}

/**
 * Asset metadata
 */
export interface AssetMetadata {
    name?: string
    symbol?: string
    decimals?: number
}

/**
 * Asset price
 */
export interface AssetPrice {
    currency: string
    value: number
}

/**
 * Asset diff for tracking balance changes
 */
export interface AssetDiff {
    address?: Address
    tokenKind?: 'native' | 'erc20' | 'erc721'
    metadata: AssetMetadata
    value: string
    direction: 'incoming' | 'outgoing'
    fiat?: AssetPrice
    recipients: Address[]
}

/**
 * Context returned by prepareCalls, used in sendPreparedCalls (spec-compliant)
 */
export type PrepareCallsContext = {
    quote: SignedQuotes
    draft?: {
        id: string
        seqKey: string
        expiresAtMs: number
        fromCache: boolean
    }
}

/**
 * Capabilities in the prepareCalls response
 */
export interface PrepareCallsCapabilities {
    feeTotals: Record<string, AssetPrice>
    assetDiffs: Record<string, Array<[Address, AssetDiff[]]>>
}

export type PrepareCallsTypedDataDomain = {
    name: string
    version: string
    chainId: number
    verifyingContract: Address
}

/**
 * Result of wallet_prepareCalls (spec-compliant)
 */
export interface PrepareCallsResult {
    context: PrepareCallsContext
    digest: Hex
    typedData: {
        domain: PrepareCallsTypedDataDomain
        types: IntentTypes
        primaryType: 'Intent'
        message: Record<string, unknown>
    }
    capabilities: PrepareCallsCapabilities
    signature: Hex
}
