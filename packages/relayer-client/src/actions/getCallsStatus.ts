/**
 * Get calls status from relayer
 */

import type { RelayerPublicClient, BundleStatusResponse } from '../types'
import { createRelayerTransport } from '../transport'
import type { RpcGetCallsStatusResult } from '../rpc-schema'

export interface GetCallsStatusParams {
    /** Bundle ID to check */
    id: string
    /** Optional chain ID to scope lookup */
    chainId?: number
}

/**
 * Map numeric status code to string status
 *
 * Status codes:
 * - 100: Pending - still waiting for confirmation
 * - 200: Confirmed - intent executed successfully
 * - 201: PreConfirmed - preconfirmation received
 * - 300: Failed - tx never submitted/mined (offchain failure)
 * - 400: Reverted - tx mined but intent failed on-chain
 * - 500: PartiallyReverted - some intents in bundle failed
 * - 404: NotFound - bundle ID not found
 */
function statusCodeToString(
    code: number,
): 'pending' | 'confirmed' | 'failed' | 'reverted' | 'not_found' {
    switch (code) {
        case 200:
        case 201:
            return 'confirmed'
        case 300:
            return 'failed'
        case 400:
        case 500:
            return 'reverted'
        case 404:
            return 'not_found'
        default:
            return 'pending'
    }
}

/**
 * Get the status of submitted calls
 *
 * Uses JSON-RPC `wallet_getCallsStatus` method.
 *
 * @example
 * ```typescript
 * const status = await client.getCallsStatus({ id: 'abc123' })
 * console.log(status.status) // 'pending' | 'confirmed' | 'failed' | 'not_found'
 * ```
 */
export async function getCallsStatus(
    client: RelayerPublicClient,
    params: GetCallsStatusParams,
): Promise<BundleStatusResponse> {
    try {
        const transport = createRelayerTransport(client)
        const chainId = params.chainId ?? client.relayerConfig.chainId ?? client.chain?.id

        const rpcParams =
            chainId !== undefined
                ? {
                      id: params.id,
                      chain_id: `0x${chainId.toString(16)}`,
                  }
                : params.id

        const result = await transport.request<RpcGetCallsStatusResult>(
            'wallet_getCallsStatus',
            rpcParams,
        )

        const status = statusCodeToString(result.status)
        const receipt = result.receipts[0] // Receipts is now required (can be empty array)

        return {
            success: true,
            id: result.id,
            status,
            statusCode: result.status,
            receipt: receipt
                ? {
                      transactionHash: receipt.transaction_hash,
                      blockNumber: receipt.block_number ?? '0',
                      gasUsed: receipt.gas_used,
                      status: receipt.status ? 'success' : 'reverted',
                      intentError: receipt.intent_error,
                  }
                : undefined,
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        }
    }
}
