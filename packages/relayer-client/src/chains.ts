/**
 * Chain configuration helper for the client
 *
 * Provides proper chain configuration for any supported EVM chain,
 * with fallback for unknown chains.
 */

import type { Chain } from 'viem'
import {
    anvil,
    baseSepolia,
    base,
    mainnet,
    sepolia,
    optimism,
    arbitrum,
    polygon,
} from 'viem/chains'

/**
 * Supported chains with full configuration
 */
const SUPPORTED_CHAINS: Record<number, Chain> = {
    // Local development
    31337: anvil,

    // Ethereum
    1: mainnet,
    11155111: sepolia,

    // Base
    8453: base,
    84532: baseSepolia,

    // Other L2s
    10: optimism,
    42161: arbitrum,
    137: polygon,
}

/**
 * Get chain configuration for a specific chainId
 *
 * @param chainId - The chain ID
 * @param rpcUrl - The RPC URL to use (overrides default)
 * @returns Chain configuration compatible with viem
 */
export function getChain(chainId: number, rpcUrl: string): Chain {
    const baseChain = SUPPORTED_CHAINS[chainId]

    if (baseChain) {
        // Use known chain config but override RPC URL
        return {
            ...baseChain,
            rpcUrls: {
                default: { http: [rpcUrl] },
            },
        }
    }

    // Fallback: create minimal chain config for unknown chains
    return {
        id: chainId,
        name: `Chain ${chainId}`,
        nativeCurrency: {
            name: 'Ether',
            symbol: 'ETH',
            decimals: 18,
        },
        rpcUrls: {
            default: { http: [rpcUrl] },
        },
    }
}

/**
 * Check if a chain is explicitly supported (has full config)
 */
export function isKnownChain(chainId: number): boolean {
    return chainId in SUPPORTED_CHAINS
}

/**
 * Get list of known chain IDs
 */
export function getKnownChainIds(): number[] {
    return Object.keys(SUPPORTED_CHAINS).map(Number)
}
