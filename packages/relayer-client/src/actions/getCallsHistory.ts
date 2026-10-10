import type { Address } from 'viem'
import type { RelayerPublicClient } from '../types'
import { createRelayerTransport } from '../transport'
import type { RpcGetCallsHistoryParams, RpcGetCallsHistoryResult } from '../rpc-schema'

interface GetCallsHistoryParamsBase {
    /** EOA address to fetch history for */
    address: Address
    /** Optional chain IDs to scope the query */
    chainIds?: number[]
    /** Max items to return (default 20, max 100) */
    limit?: number
    /** Offset for pagination (default 0) */
    offset?: number
}

export type GetCallsHistoryParams = GetCallsHistoryParamsBase

export interface CallsHistoryItem {
    id: string
    chainId: number
    createdAt: number
}

export type GetCallsHistoryResponse =
    | {
          success: true
          items: CallsHistoryItem[]
          total: number
      }
    | {
          success: false
          error: string
      }

/**
 * Get paginated history of call bundles for an EOA address
 *
 * Uses JSON-RPC `wallet_getCallsHistory` method.
 *
 * @example
 * ```typescript
 * const history = await client.getCallsHistory({ address: '0x...' })
 * console.log(history.items) // [{ id: '...', chainId: 8453, createdAt: 1234567890 }]
 * ```
 */
export async function getCallsHistory(
    client: RelayerPublicClient,
    params: GetCallsHistoryParams,
): Promise<GetCallsHistoryResponse> {
    try {
        const transport = createRelayerTransport(client)

        const rpcParams: RpcGetCallsHistoryParams = { address: params.address }

        if (params.chainIds && params.chainIds.length > 0) {
            rpcParams.chainIds = params.chainIds.map((id) => `0x${id.toString(16)}`)
        }

        if (params.limit !== undefined) rpcParams.limit = params.limit

        if (params.offset !== undefined) rpcParams.offset = params.offset

        const result = await transport.request<RpcGetCallsHistoryResult>(
            'wallet_getCallsHistory',
            rpcParams,
        )

        const items: CallsHistoryItem[] = result.items.map((item) => ({
            id: item.id,
            chainId: Number.parseInt(item.chain_id, 16),
            createdAt: item.created_at,
        }))

        return { success: true, items, total: result.total }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        }
    }
}
