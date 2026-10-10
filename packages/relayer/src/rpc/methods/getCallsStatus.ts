import type { Hex } from 'viem'
import type { JsonRpcParams, RpcContext } from '../types'
import type { Env } from '../../types/env'
import type { GetCallsStatusResult } from '../schema/getCallsStatus'
import { getChainIds } from '../../config'
import { logger, getErrorMessage } from '../../lib/logger'
import { parseHexChainId, unwrapParams } from '../../lib/rpc-utils'
import { RpcError, INVALID_PARAMS } from '../errors'

export type { GetCallsStatusResult } from '../schema/getCallsStatus'

/**
 * wallet_getCallsStatus - Get status of a submitted bundle.
 */
export async function handleGetCallsStatus(
    params: JsonRpcParams | string | { id?: string } | undefined,
    ctx: RpcContext,
): Promise<GetCallsStatusResult> {
    const env = ctx.env as Env

    const firstParam = unwrapParams<unknown>(params)

    const bundleId =
        typeof firstParam === 'string' ? firstParam : (firstParam as { id?: string })?.id

    if (!bundleId) {
        throw new RpcError(INVALID_PARAMS, 'Missing required parameter: bundle ID')
    }

    let statusCode = 404
    let receipts: GetCallsStatusResult['receipts'] = []
    let chainIdsToCheck: number[] = []

    if (typeof firstParam === 'object' && firstParam) {
        const maybeChainId = (firstParam as { chain_id?: string }).chain_id

        if (maybeChainId) {
            chainIdsToCheck = [parseHexChainId(maybeChainId, 'chain_id')]
        }
    }

    if (chainIdsToCheck.length === 0) {
        chainIdsToCheck = getChainIds(env)
    }

    if (env.BUNDLE_STATUS_DO) {
        try {
            for (const chainId of chainIdsToCheck) {
                const bundleStatusId = env.BUNDLE_STATUS_DO.idFromName(`bundle-status-${chainId}`)
                const bundleStatus = env.BUNDLE_STATUS_DO.get(bundleStatusId)

                const response = await bundleStatus.fetch(
                    `http://do/get_bundle_status?bundleId=${bundleId}`,
                )

                if (!response.ok) {
                    continue
                }

                const result = (await response.json()) as {
                    bundleId: string
                    status: 'pending' | 'confirmed' | 'failed' | 'not_found'
                    statusCode: number
                    receipts: Array<{
                        chain_id: string
                        transaction_hash: Hex
                        status: boolean
                        block_hash?: string
                        block_number?: string
                        gas_used: string
                        logs: unknown[]
                    }>
                }

                if (result.status !== 'not_found') {
                    statusCode = result.statusCode
                    receipts = result.receipts
                    break
                }
            }
        } catch (error) {
            logger.warn(
                { error: getErrorMessage(error), bundleId },
                'Failed to get bundle status from BundleStatusDO',
            )
            statusCode = 404
            receipts = []
        }
    }

    return {
        id: bundleId,
        status: statusCode,
        receipts,
    }
}
