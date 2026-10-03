import type { Address, Hex, TypedDataDomain } from 'viem'

/**
 * Key types supported for authorization
 */
export type KeyType = 'secp256k1' | 'external'

/**
 * Spend period for spending limits
 */
export type SpendPeriod = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' | 'forever'

/**
 * Call permission
 */
export interface CallPermission {
    type: 'call'
    to: Address
    selector: Hex
}

/**
 * Spend permission
 */
export interface SpendPermission {
    type: 'spend'
    token: Address
    limit: string
    period: SpendPeriod
}

/**
 * Permission types
 */
export type Permission = CallPermission | SpendPermission

/**
 * Key authorization request
 */
export interface AuthorizeKey {
    expiry: string
    type: KeyType
    role: 'admin' | 'normal'
    publicKey: Hex
    permissions: Permission[]
}

/**
 * Key authorization response (includes hash)
 */
export interface AuthorizeKeyResponse extends AuthorizeKey {
    hash: Hex
}

/**
 * EIP-7702 Authorization (unsigned)
 */
export interface Authorization {
    contractAddress: Address
    chainId: number
    nonce: number
}

/**
 * Signed call for precall execution
 */
export interface SignedCall {
    eoa: Address
    executionData: Hex
    nonce: string
    signature: Hex
    chainId: string
}

/**
 * Parameters for wallet_prepareUpgradeAccount (spec-compliant)
 */
export interface PrepareUpgradeParams {
    /** EOA address to upgrade */
    address: Address
    /** Target chain ID (hex), defaults to relayer's chain */
    chainId?: string
    /** Account implementation address, defaults to config */
    delegation: Address
    /** Capabilities for the upgrade */
    capabilities: {
        authorizeKeys: AuthorizeKey[]
    }
}

/**
 * Context returned by prepareUpgradeAccount (spec-compliant)
 */
export interface UpgradeAccountContext {
    /** EOA address being upgraded */
    address: Address
    /** Target chain ID (hex) */
    chainId: string
    /** EIP-7702 authorization (unsigned) */
    authorization: Authorization
    /** PreCall for key initialization */
    preCall: SignedCall
}

/**
 * Digests to sign for account upgrade
 */
export interface UpgradeAccountDigests {
    /** EIP-7702 authorization digest */
    auth: Hex
    /** Precall execution digest */
    exec: Hex
}

/**
 * Capabilities in the upgrade response
 */
export interface UpgradeAccountCapabilities {
    authorizeKeys: AuthorizeKeyResponse[]
}

/**
 * Result of wallet_prepareUpgradeAccount (spec-compliant)
 */
export interface PrepareUpgradeResult {
    /** Chain ID (hex) */
    chainId: string
    /** Context to pass to upgradeAccount */
    context: UpgradeAccountContext
    /** Digests to sign */
    digests: UpgradeAccountDigests
    /** EIP-712 typed data for the exec signature */
    typedData: {
        domain: TypedDataDomain
        types: Record<string, ReadonlyArray<{ name: string; type: string }>>
        primaryType: string
        message: Record<string, unknown>
    }
    /** Capabilities with processed keys */
    capabilities: UpgradeAccountCapabilities
}

/**
 * Signatures for wallet_upgradeAccount
 */
export interface UpgradeAccountSignatures {
    /** EIP-7702 authorization signature */
    auth: Hex
    /** Precall execution signature */
    exec: Hex
}

/**
 * Parameters for wallet_upgradeAccount (spec-compliant)
 */
export interface UpgradeAccountParams {
    /** Context from prepareUpgradeAccount */
    context: UpgradeAccountContext
    /** Both signatures */
    signatures: UpgradeAccountSignatures
}

/**
 * Result of wallet_upgradeAccount
 *
 * Returns success: true only after the delegation tx is mined and confirmed.
 * This allows clients to proceed immediately without polling.
 */
export interface UpgradeAccountResult {
    success: boolean
    txHash?: string
}
