/**
 * Poll bundle status until final status is reached
 *
 * This is a thin wrapper around the SDK's waitForBundle for test compatibility.
 */

import type { RelayerPublicClient, BundleStatusResponse } from '../../src/types'
import { waitForBundle } from '../../src/actions/waitForBundle'

export interface PollBundleStatusOptions {
    /** Polling interval in milliseconds (default: 500ms) */
    intervalMs?: number
    /** Timeout in milliseconds (default: 30000ms = 30 seconds) */
    timeoutMs?: number
}

/**
 * Poll bundle status until final status is reached
 *
 * @deprecated Use client.waitForBundle() directly instead
 */
export async function pollBundleStatus(
    client: RelayerPublicClient,
    bundleId: string,
    options?: PollBundleStatusOptions,
): Promise<BundleStatusResponse> {
    return waitForBundle(client, {
        bundleId,
        intervalMs: options?.intervalMs,
        timeoutMs: options?.timeoutMs,
    })
}
