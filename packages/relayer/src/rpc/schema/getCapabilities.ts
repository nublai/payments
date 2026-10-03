import type { Address } from 'viem'

/**
 * Parameters for wallet_getCapabilities
 */
export interface GetCapabilitiesParams {
    /** Hex-encoded chain IDs to filter (e.g., ["0x1", "0xa"]) */
    chains?: string[]
}

/**
 * Versioned contract addresses (spec-compliant)
 */
export interface VersionedContracts {
    orchestrator: Address
    delegation: Address
    simulator: Address
}

/**
 * Quote configuration for fee estimation
 */
export interface QuoteConfig {
    /** Default quote TTL in seconds */
    ttlSeconds?: number
}

/**
 * Fee token configuration
 */
export interface ChainFeeToken {
    /** Asset unique identifier (e.g., "usdc") */
    uid: string
    /** Token address */
    address: Address
    /** Token decimals */
    decimals: number
    /** Whether this token can be used for fees */
    feeToken: boolean
    /** Token symbol */
    symbol?: string
    /** Rate of 1 token against native token (hex) */
    nativeRate?: string
}

/**
 * Fees configuration (spec-compliant)
 */
export interface ChainFees {
    recipient: Address
    quoteConfig: QuoteConfig
    tokens: ChainFeeToken[]
}

/**
 * Individual signer information
 */
export interface SignerInfo {
    index: number
    address: string | null
    balance: string | null
    balanceEth: string | null
    capacity: number
    pending: number
    paused: boolean
}

/**
 * Pool status information
 */
export interface PoolInfo {
    signerCount: number
    totalCapacity: number
    totalPending: number
    availableCapacity: number
    signers: SignerInfo[]
}

/**
 * Capabilities for a single chain (spec-compliant)
 */
export interface ChainCapabilities {
    contracts: VersionedContracts
    fees: ChainFees
    pool: PoolInfo
}

/**
 * Result type for wallet_getCapabilities
 */
export type GetCapabilitiesResult = Record<string, ChainCapabilities>
