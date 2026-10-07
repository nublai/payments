/**
 * Wait for bundle to reach final status
 *
 * Polls wallet_getCallsStatus at intervals until the bundle reaches a final status.
 */

import type { RelayerPublicClient, BundleStatusResponse } from '../types'
import { getCallsStatus } from './getCallsStatus'

export interface WaitForBundleParams {
    /** Bundle ID to wait for */
    id: string
    /** Optional chain ID to scope lookup */
    chainId?: number
    /** Polling interval in milliseconds (default: 500ms) */
    intervalMs?: number
    /** Timeout in milliseconds (default: 30000ms = 30 seconds) */
    timeoutMs?: number
}

/**
 * Final status codes that indicate the bundle is complete
 * - 200: Confirmed
 * - 201: PreConfirmed
 * - 300: Failed (offchain)
 * - 400: Reverted (on-chain intent failure)
 * - 500: PartiallyReverted
 */
const FINAL_STATUS_CODES = [200, 201, 300, 400, 500] as const

/**
 * Wait for bundle to reach final status
 *
 * Polls the relayer until the bundle reaches a final status (confirmed, failed, or reverted).
 *
 * This is a standalone utility function, not on the client.
 *
 * @example
 * ```typescript
 * import { waitForBundle } from '@nubl/relayer-client'
 *
 * const { id } = await client.sendPreparedCalls({ context, signature })
 * const status = await waitForBundle(client, {
 *   id,
 *   timeoutMs: 60_000
 * })
 *
 * if (status.status === 'confirmed') {
 *   console.log('Success!', status.receipt?.transactionHash)
 * } else if (status.status === 'reverted') {
 *   console.log('Intent failed on-chain:', status.receipt?.intentError)
 * }
 * ```
 */
export async function waitForBundle(
    client: RelayerPublicClient,
    params: WaitForBundleParams,
): Promise<BundleStatusResponse> {
    const { id, chainId, intervalMs = 500, timeoutMs = 30000 } = params
    const startTime = Date.now()

    while (true) {
        const status = await getCallsStatus(client, { id, chainId })
        const elapsed = Date.now() - startTime

        if (!status.success) {
            if (elapsed >= timeoutMs) {
                throw new Error(
                    `Timeout waiting for bundle ${id} to reach final status. Current status: ${status.error ?? 'unknown'}`,
                )
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs))
            continue
        }

        if (
            status.statusCode &&
            FINAL_STATUS_CODES.includes(status.statusCode as (typeof FINAL_STATUS_CODES)[number])
        ) {
            return status
        }

        if (elapsed >= timeoutMs) {
            throw new Error(
                `Timeout waiting for bundle ${id} to reach final status. Current status: ${status.statusCode ?? 'unknown'}`,
            )
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
}
