/**
 * Get authorized keys for a delegated account
 */

import type { Address } from 'viem'
import type { RelayerPublicClient } from '../types'
import { createRelayerTransport } from '../transport'
import type {
    RpcAuthorizedKeyResponse,
    RpcGetKeysParams,
    RpcGetKeysResult,
    RpcPermissionResponse,
    RpcSpendPermissionResponse,
} from '../rpc-schema'

export interface GetKeysParams extends Omit<RpcGetKeysParams, 'chainIds'> {
    /** The address of the delegated account */
    address: Address
    /** Optional chain IDs to filter */
    chainIds?: number[]
}

/**
 * Spend permission response
 */
export type SpendPermissionInfo = RpcSpendPermissionResponse

/**
 * Call permission response
 */
export type CallPermissionInfo = Extract<RpcPermissionResponse, { type: 'call' }>

/**
 * Permission info
 */
export type PermissionInfo = RpcPermissionResponse

/**
 * Authorized key information
 */
export type AuthorizedKeyInfo = RpcAuthorizedKeyResponse

/**
 * Response from getKeys - maps chain ID (hex) to array of keys
 */
export type GetKeysResponse = RpcGetKeysResult

/**
 * Get authorized keys for a delegated account
 *
 * Uses JSON-RPC `wallet_getKeys` method.
 *
 * Returns all authorized keys and their permissions for the account.
 *
 * @example
 * ```typescript
 * const keys = await client.getKeys({ address: accountAddress })
 *
 * // Keys are indexed by chain ID (hex)
 * const chainId = `0x${client.chain.id.toString(16)}`
 * const accountKeys = keys[chainId]
 *
 * for (const key of accountKeys) {
 *   console.log(`Key ${key.hash}: ${key.type} (${key.role})`)
 *   for (const perm of key.permissions) {
 *     if (perm.type === 'spend') {
 *       console.log(`  Spend: ${perm.token} limit ${perm.limit}`)
 *     } else {
 *       console.log(`  Call: ${perm.to} ${perm.selector}`)
 *     }
 *   }
 * }
 * ```
 */
export async function getKeys(
    client: RelayerPublicClient,
    params: GetKeysParams,
): Promise<GetKeysResponse> {
    const transport = createRelayerTransport(client)
    const rpcParams: Record<string, unknown> = {
        address: params.address,
    }
    if (params.chainIds && params.chainIds.length > 0) {
        rpcParams.chainIds = params.chainIds.map((id) => `0x${id.toString(16)}`)
    }

    const result = await transport.request<GetKeysResponse>('wallet_getKeys', rpcParams)

    return result
}
