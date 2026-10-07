/**
 * Send prepared calls to the relayer
 */

import type { RelayerPublicClient } from '../types'
import { createRelayerTransport } from '../transport'
import type { RpcSendPreparedCallsParams, RpcSendPreparedCallsResult } from '../rpc-schema'

export type SendPreparedCallsParams = Pick<
    RpcSendPreparedCallsParams,
    'context' | 'signature' | 'paymentSignature' | 'feeAuthorization'
>

export interface SendPreparedCallsResponse {
    /** Context from prepareCalls */
    /** Bundle ID for status tracking */
    id: string
}

/**
 * Send prepared calls to the relayer
 *
 * Uses JSON-RPC `wallet_sendPreparedCalls` method.
 *
 * @example
 * ```typescript
 * const prepared = await client.prepareCalls({
 *   from: accountAddress,
 *   calls: [{ target, value: 0n, data }]
 * })
 *
 * const signature = await walletClient.signTypedData(prepared.typedData)
 *
 * const { id } = await client.sendPreparedCalls({
 *   context: prepared.context,
 *   signature
 * })
 *
 * // Wait for confirmation
 * const status = await waitForBundle(client, { id })
 * ```
 */
export async function sendPreparedCalls(
    client: RelayerPublicClient,
    params: SendPreparedCallsParams,
): Promise<SendPreparedCallsResponse> {
    const transport = createRelayerTransport(client)

    const rpcParams: Record<string, unknown> = {
        context: params.context,
        signature: params.signature,
    }

    if (params.paymentSignature) {
        rpcParams.paymentSignature = params.paymentSignature
    }

    const result = await transport.request<RpcSendPreparedCallsResult>(
        'wallet_sendPreparedCalls',
        rpcParams,
    )

    return {
        id: result.id,
    }
}
