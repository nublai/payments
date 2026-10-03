/**
 * Get relayer capabilities
 */

import type { RelayerPublicClient, CapabilitiesResponse } from '../types'
import { createRelayerTransport } from '../transport'
import type { RpcGetCapabilitiesParams, RpcGetCapabilitiesResult } from '../rpc-schema'

/**
 * JSON-RPC capabilities params
 */
export interface GetCapabilitiesParams extends RpcGetCapabilitiesParams {
    /** Optional chain IDs to filter (hex format) */
    chains?: string[]
    /** Optional numeric chain IDs to filter */
    chainIds?: number[]
}

/**
 * Get relayer capabilities and configuration
 *
 * Uses JSON-RPC `wallet_getCapabilities` method.
 *
 * @example
 * ```typescript
 * const caps = await getCapabilities(client)
 * console.log(caps.capabilities?.accountCreation) // true/false
 * ```
 */
export async function getCapabilities(
    client: RelayerPublicClient,
    params?: GetCapabilitiesParams,
): Promise<CapabilitiesResponse> {
    try {
        const transport = createRelayerTransport(client)
        const rpcParams =
            params?.chainIds && params.chainIds.length > 0
                ? {
                      ...params,
                      chains: params.chainIds.map((id) => `0x${id.toString(16)}`),
                  }
                : params
        const result = await transport.request<RpcGetCapabilitiesResult>(
            'wallet_getCapabilities',
            rpcParams,
        )

        // Extract first chain's data for backwards compatibility
        const chainIds = Object.keys(result)
        const chainId = chainIds[0]
        const chainData = chainId ? result[chainId] : undefined
        const contracts = chainData?.contracts
        const pool = chainData?.pool

        if (!pool) {
            throw new Error('Pool information not found in capabilities response')
        }

        return {
            success: true,
            version: '2.0.0',
            chainId: chainId ? parseInt(chainId, 16) : undefined,
            contracts: contracts
                ? {
                      orchestrator: contracts.orchestrator,
                      simulator: contracts.simulator,
                      // delegation is the accountProxy (EIP-7702 target)
                      accountProxy: contracts.delegation,
                  }
                : undefined,
            capabilities: {
                accountCreation: true,
                intentExecution: true,
                simulation: true,
                prepare: true,
                statusTracking: true,
                batchExecution: true,
            },
            pool: {
                signerCount: pool.signerCount,
                totalCapacity: pool.totalCapacity,
                totalPending: pool.totalPending,
                availableCapacity: pool.availableCapacity,
                signers: pool.signers,
            },
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            pool: {
                signerCount: 0,
                totalCapacity: 0,
                totalPending: 0,
                availableCapacity: 0,
                signers: [],
            },
        }
    }
}
