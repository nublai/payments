/**
 * Check relayer health
 */

import type { RelayerPublicClient, HealthResponse } from '../types'
import { createRelayerTransport } from '../transport'

/**
 * JSON-RPC health response
 */
interface WalletHealthResult {
    version: string
}

/**
 * Check relayer health status
 *
 * Uses JSON-RPC `wallet_health` method.
 *
 * @example
 * ```typescript
 * const health = await checkHealth(client)
 * console.log(health.status) // 'ok' | 'error'
 * ```
 */
export async function checkHealth(client: RelayerPublicClient): Promise<HealthResponse> {
    try {
        const transport = createRelayerTransport(client)
        await transport.request<WalletHealthResult>('wallet_health')

        // Map to legacy HealthResponse format for backwards compatibility
        return {
            status: 'ok',
            chainId: client.chain?.id ?? 0,
            contracts: {
                orchestrator: '0x0000000000000000000000000000000000000000',
                simulator: '0x0000000000000000000000000000000000000000',
                townsAccount: '0x0000000000000000000000000000000000000000',
            },
            mode: 'pool',
        }
    } catch (error) {
        return {
            status: 'error',
            chainId: client.chain?.id ?? 0,
            contracts: {
                orchestrator: '0x0000000000000000000000000000000000000000',
                simulator: '0x0000000000000000000000000000000000000000',
                townsAccount: '0x0000000000000000000000000000000000000000',
            },
            error: error instanceof Error ? error.message : 'Unknown error',
        }
    }
}
