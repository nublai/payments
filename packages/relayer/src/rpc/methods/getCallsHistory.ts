import type { RpcContext } from '../types'
import type { Env } from '../../types/env'
import type {
    GetCallsHistoryParams,
    GetCallsHistoryResult,
    CallHistoryItem,
} from '../schema/getCallsHistory'
import { getChainIds } from '../../config'
import { logger, getErrorMessage } from '../../lib/logger'
import { parseHexChainId, requireParam, validateAddress, unwrapParams } from '../../lib/rpc-utils'
import { toHexChainId } from '../../lib/viem-utils'
import { RpcError, INVALID_PARAMS } from '../errors'

export type {
    GetCallsHistoryParams,
    GetCallsHistoryResult,
    CallHistoryItem,
} from '../schema/getCallsHistory'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_TARGET_SIZE = 1000

interface BundleHistoryEntry {
    bundleId: string
    chainId: number
    createdAt: number
}

interface BundleStatusHistoryStub {
    getBundlesByEoa: (
        eoa: string,
        limit: number,
        offset: number,
    ) => Promise<{ items: BundleHistoryEntry[]; total: number }>
}

type ChainQueryResult =
    | {
          ok: true
          chainId: number
          bundleStatusDo: BundleStatusHistoryStub
          result: { items: BundleHistoryEntry[]; total: number }
      }
    | {
          ok: false
          chainId: number
          error: unknown
      }

interface ChainHistoryState {
    chainId: number
    doStub: BundleStatusHistoryStub
    total: number
    nextOffset: number
    page: BundleHistoryEntry[]
    pageIndex: number
}

function compareHistoryEntriesDesc(a: BundleHistoryEntry, b: BundleHistoryEntry): number {
    if (a.createdAt !== b.createdAt) {
        return b.createdAt - a.createdAt
    }
    if (a.chainId !== b.chainId) {
        return b.chainId - a.chainId
    }
    return b.bundleId.localeCompare(a.bundleId)
}

async function ensureCurrentEntry(
    state: ChainHistoryState,
    normalizedAddress: string,
    pageSize: number,
): Promise<BundleHistoryEntry | null> {
    while (state.pageIndex >= state.page.length) {
        if (state.nextOffset >= state.total) {
            return null
        }

        const nextPage = await state.doStub.getBundlesByEoa(
            normalizedAddress,
            pageSize,
            state.nextOffset,
        )

        state.total = nextPage.total
        state.page = nextPage.items
        state.pageIndex = 0
        state.nextOffset += nextPage.items.length

        if (nextPage.items.length === 0) {
            return null
        }
    }

    return state.page[state.pageIndex]
}

/**
 * wallet_getCallsHistory - Returns paginated history of call bundles for an EOA address
 */
export async function handleGetCallsHistory(
    params: unknown,
    ctx: RpcContext,
): Promise<GetCallsHistoryResult> {
    const env = ctx.env as Env

    const typedParams = unwrapParams<GetCallsHistoryParams>(params)

    const address = validateAddress(requireParam(typedParams?.address, 'address'), 'address')
    const normalizedAddress = address.toLowerCase()

    const limit = Math.min(typedParams?.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const offset = typedParams?.offset ?? 0

    if (!Number.isInteger(limit) || limit < 1) {
        throw new RpcError(INVALID_PARAMS, 'limit must be a positive integer')
    }
    if (!Number.isInteger(offset) || offset < 0) {
        throw new RpcError(INVALID_PARAMS, 'offset must be a non-negative integer')
    }
    if (offset + limit > MAX_TARGET_SIZE) {
        throw new RpcError(
            INVALID_PARAMS,
            `offset + limit must be less than or equal to ${MAX_TARGET_SIZE}`,
        )
    }

    let chainIdsToCheck: number[] = []
    if (typedParams?.chainIds && typedParams.chainIds.length > 0) {
        chainIdsToCheck = [
            ...new Set(typedParams.chainIds.map((value) => parseHexChainId(value, 'chainId'))),
        ]
    } else {
        chainIdsToCheck = getChainIds(env)
    }

    const pageSize = Math.min(Math.max(limit, DEFAULT_LIMIT), MAX_LIMIT)
    const merged: BundleHistoryEntry[] = []
    const states: ChainHistoryState[] = []
    let total = 0

    const bundleStatusNamespace = env.BUNDLE_STATUS_DO
    if (bundleStatusNamespace) {
        const chainResults: ChainQueryResult[] = await Promise.all(
            chainIdsToCheck.map(async (chainId) => {
                try {
                    const doId = bundleStatusNamespace.idFromName(`bundle-status-${chainId}`)
                    const bundleStatusDo = bundleStatusNamespace.get(
                        doId,
                    ) as BundleStatusHistoryStub
                    const result = await bundleStatusDo.getBundlesByEoa(
                        normalizedAddress,
                        pageSize,
                        0,
                    )
                    return { ok: true, chainId, bundleStatusDo, result } as const
                } catch (error) {
                    return { ok: false, chainId, error } as const
                }
            }),
        )

        for (const chainResult of chainResults) {
            if (chainResult.ok) {
                states.push({
                    chainId: chainResult.chainId,
                    doStub: chainResult.bundleStatusDo,
                    total: chainResult.result.total,
                    nextOffset: chainResult.result.items.length,
                    page: chainResult.result.items,
                    pageIndex: 0,
                })
                total += chainResult.result.total
                continue
            }

            logger.warn(
                { error: getErrorMessage(chainResult.error), chainId: chainResult.chainId },
                'Failed to query BundleStatusDO for calls history',
            )
        }
    }

    const targetSize = offset + limit
    while (merged.length < targetSize) {
        const candidates: Array<{ state: ChainHistoryState; entry: BundleHistoryEntry }> = []

        for (let index = states.length - 1; index >= 0; index -= 1) {
            const state = states[index]
            let current: BundleHistoryEntry | null = null
            try {
                current = await ensureCurrentEntry(state, normalizedAddress, pageSize)
            } catch (error) {
                logger.warn(
                    { error: getErrorMessage(error), chainId: state.chainId },
                    'Failed to query BundleStatusDO for calls history',
                )
                total = Math.max(0, total - state.total)
                states.splice(index, 1)
                continue
            }
            if (current) {
                candidates.push({ state, entry: current })
            }
        }

        if (candidates.length === 0) {
            break
        }

        candidates.sort((a, b) => compareHistoryEntriesDesc(a.entry, b.entry))
        const selected = candidates[0]
        merged.push(selected.entry)
        selected.state.pageIndex += 1
    }

    const page = merged.slice(offset, offset + limit)

    const items: CallHistoryItem[] = page.map((entry) => ({
        id: entry.bundleId,
        chain_id: toHexChainId(entry.chainId),
        created_at: entry.createdAt,
    }))

    logger.info(
        {
            address: normalizedAddress,
            chainCount: chainIdsToCheck.length,
            resultCount: items.length,
        },
        'Retrieved calls history',
    )

    return { items, total }
}
