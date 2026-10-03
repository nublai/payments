import type { Address, Hex } from 'viem'
import type { CallPermission, KeyType, SpendPermission } from './upgradeAccount'

/**
 * Spend permission response - extends SpendPermission with current spent amount
 */
export interface SpendPermissionResponse extends Omit<SpendPermission, 'limit'> {
    limit: Hex
    spent: Hex
}

/**
 * Permission types returned by getKeys
 */
export type PermissionResponse = CallPermission | SpendPermissionResponse

/**
 * Authorized key response with permissions
 */
export interface AuthorizedKeyResponse {
    hash: Hex
    expiry: Hex
    type: KeyType
    role: 'admin' | 'normal'
    publicKey: Hex
    permissions: PermissionResponse[]
}

/**
 * Parameters for wallet_getKeys
 */
export interface GetKeysParams {
    address: Address
    chainIds?: string[]
}

/**
 * Result type for wallet_getKeys - keyed by hex chain ID
 */
export type GetKeysResult = Record<string, AuthorizedKeyResponse[]>
