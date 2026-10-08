/**
 * Viem utility functions for chain and client creation
 */

import { createPublicClient, http, type Chain, type PublicClient } from 'viem'

/**
 * Create a viem Chain configuration object
 */
export function createChain(chainId: number, rpcUrl: string): Chain {
    return {
        id: chainId,
        name: `Chain ${chainId}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
    }
}

/**
 * Create a viem PublicClient for the given chain
 */
export function createRelayerPublicClient(chainId: number, rpcUrl: string): PublicClient {
    const chain = createChain(chainId, rpcUrl)

    return createPublicClient({
        chain,
        transport: http(rpcUrl),
    })
}

/**
 * Convert a chain ID to hex format (e.g., 84532 -> "0x14a34")
 */
export function toHexChainId(chainId: number): string {
    return `0x${chainId.toString(16)}`
}

/**
 * Check if an account has any code (is a contract or delegated)
 */
export function hasCode(code: string | undefined): boolean {
    return !!code && code !== '0x' && code.length > 2
}

/**
 * Check if an account has EIP-7702 delegation bytecode
 * EIP-7702 delegation starts with 0xef0100
 */
export function isEip7702Delegated(code: string | undefined): boolean {
    return hasCode(code) && code!.startsWith('0xef01')
}
