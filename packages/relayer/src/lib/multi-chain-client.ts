/**
 * Multi-chain client management for per-chain RPC access.
 *
 * Provides cached viem public clients per chainId.
 */

import { createPublicClient, http, type PublicClient, type Chain } from 'viem'
import type { Env } from '../types/env'

const publicClientCache = new Map<number, PublicClient>()

/**
 * Create a viem Chain configuration for the given chainId
 */
function createChainConfig(chainId: number, rpcUrl: string): Chain {
    return {
        id: chainId,
        name: `Chain ${chainId}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
    }
}

/**
 * Get the RPC URL for a specific chain
 * Looks for RPC_<chainId> first, falls back to RPC_URL
 */
export function getChainRpcUrl(chainId: number, env: Partial<Env>): string {
    const chainSpecificKey = `RPC_${chainId}` as keyof Env
    const chainRpc = env[chainSpecificKey] as string | undefined
    if (chainRpc) {
        return chainRpc
    }

    const defaultRpc = env.RPC_URL
    if (defaultRpc) {
        return defaultRpc
    }

    throw new Error(`No RPC configured for chain ${chainId}. Set RPC_${chainId} or RPC_URL`)
}

/**
 * Get a cached PublicClient for the given chainId
 *
 * Uses RPC_<chainId> if available, otherwise falls back to RPC_URL.
 * Clients are cached per chainId for reuse.
 */
export function getChainClient(chainId: number, env: Partial<Env>): PublicClient {
    const cached = publicClientCache.get(chainId)
    if (cached) {
        return cached
    }

    const rpcUrl = getChainRpcUrl(chainId, env)
    const chain = createChainConfig(chainId, rpcUrl)

    const client = createPublicClient({
        chain,
        transport: http(rpcUrl),
    })

    publicClientCache.set(chainId, client)
    return client
}
