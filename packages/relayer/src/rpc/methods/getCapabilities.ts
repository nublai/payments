import type { Address } from 'viem'
import { formatEther } from 'viem'
import type { RpcContext } from '../types'
import type { Env } from '../../types/env'
import type { GetCapabilitiesParams, GetCapabilitiesResult } from '../schema/getCapabilities'
import { getChainConfig, getChainIds } from '../../config'
import { getFeeConfig } from '../../types/env'
import { logger, getErrorMessage } from '../../lib/logger'
import { jsonRpcRequest } from '../../lib/json-rpc'
import { toHexChainId } from '../../lib/viem-utils'
import { parseHexChainId, unwrapParams } from '../../lib/rpc-utils'
import { getSignerPool } from './shared/signer-pool'

export type {
    GetCapabilitiesParams,
    GetCapabilitiesResult,
    ChainCapabilities,
    ChainFeeToken,
    ChainFees,
    PoolInfo,
    QuoteConfig,
    SignerInfo,
    VersionedContracts,
} from '../schema/getCapabilities'

async function fetchSignerBalance(rpcUrl: string, address: string): Promise<string | null> {
    try {
        const result = await jsonRpcRequest<string>(rpcUrl, 'eth_getBalance', [address, 'latest'])

        return BigInt(result).toString()
    } catch {
        return null
    }
}

/**
 * wallet_getCapabilities - Returns relay capabilities and configuration per chain.
 */
export async function handleGetCapabilities(
    params: unknown,
    ctx: RpcContext,
): Promise<GetCapabilitiesResult> {
    const env = ctx.env as Env
    const typedParams = unwrapParams<GetCapabilitiesParams>(params)
    const chainFilter = typedParams?.chains

    let chainIdsToCheck: number[] = []

    if (chainFilter && chainFilter.length > 0) {
        chainIdsToCheck = chainFilter.map((value) => parseHexChainId(value, 'chainId'))
    } else {
        chainIdsToCheck = getChainIds(env)
    }

    const feeConfig = getFeeConfig(env)
    const response: GetCapabilitiesResult = {}

    for (const chainId of chainIdsToCheck) {
        let config

        try {
            config = getChainConfig(env, chainId)
        } catch (error) {
            logger.warn(
                { error: getErrorMessage(error), chainId },
                'Skipping capabilities for unsupported chain',
            )
            continue
        }

        const hexChainId = toHexChainId(config.chainId)
        const pool = getSignerPool(env, chainId)

        let poolStatus: {
            signerCount: number
            totalCapacity: number
            totalPending: number
            signers: Array<{
                index: number
                address: string | null
                balance?: string
                capacity: number
                pending: number
                paused?: boolean
                error?: boolean
            }>
        }

        try {
            const response = await pool.fetch(`http://do/status?poolName=pool-${chainId}`)

            if (!response.ok) {
                throw new Error(
                    `Failed to fetch pool status: ${response.status} ${response.statusText}`,
                )
            }

            poolStatus = (await response.json()) as typeof poolStatus
        } catch (error) {
            logger.error(
                { error: getErrorMessage(error), chainId },
                'Failed to fetch pool status for capabilities',
            )
            continue
        }

        const signers = await Promise.all(
            poolStatus.signers.map(async (s) => {
                const chainBalance =
                    s.address && !s.error
                        ? await fetchSignerBalance(config.rpcUrl, s.address)
                        : null

                const balance = chainBalance ?? s.balance ?? null

                return {
                    index: s.index,
                    address: s.address,
                    balance,
                    balanceEth: balance ? formatEther(BigInt(balance)) : null,
                    capacity: s.capacity,
                    pending: s.pending,
                    paused: s.paused ?? false,
                }
            }),
        )

        response[hexChainId] = {
            contracts: {
                orchestrator: config.contracts.orchestrator,
                delegation: config.contracts.accountProxy,
                simulator: config.contracts.simulator,
            },
            fees: {
                recipient: (feeConfig.feeRecipient ?? config.contracts.orchestrator) as Address,
                quoteConfig: {
                    ttlSeconds: feeConfig.quoteTtlSeconds,
                },
                tokens: [],
            },
            pool: {
                signerCount: poolStatus.signerCount,
                totalCapacity: poolStatus.totalCapacity,
                totalPending: poolStatus.totalPending,
                availableCapacity: poolStatus.totalCapacity - poolStatus.totalPending,
                signers,
            },
        }
    }

    return response
}
