import type { Address } from 'viem'
import {
    ChainsConfigSchema,
    type ChainsConfig,
    type TypedChainConfig,
    type TypedAssetConfig,
} from '../types/config'
import chainsJson from './chains.json'

// Validate and cache the chains config at module load
let cachedConfig: ChainsConfig | null = null

/**
 * Load and validate the chains configuration from chains.json
 * @throws {Error} If validation fails
 */
export function loadChainsConfig(): ChainsConfig {
    if (cachedConfig) {
        return cachedConfig
    }

    const result = ChainsConfigSchema.safeParse(chainsJson)
    if (!result.success) {
        throw new Error(`Invalid chains.json: ${result.error.message}`)
    }

    cachedConfig = result.data
    return cachedConfig
}

/**
 * Get configuration for a specific chain
 * @param chainId - The chain ID to look up
 * @returns The chain config with properly typed addresses, or undefined if not found
 */
export function getChainConfig(chainId: number | string): TypedChainConfig | undefined {
    const config = loadChainsConfig()
    const chainIdStr = String(chainId)
    const chain = config.chains[chainIdStr]

    if (!chain) {
        return undefined
    }

    // Convert string addresses to viem Address type
    const typedAssets: Record<string, TypedAssetConfig> = {}
    for (const [key, asset] of Object.entries(chain.assets)) {
        typedAssets[key] = {
            ...asset,
            address: asset.address as Address,
        }
    }

    return {
        ...chain,
        assets: typedAssets,
    }
}

/**
 * Environment type for RPC URL lookup
 */
interface RpcEnv {
    RPC_URL?: string
    [key: `RPC_${string}`]: string | undefined
}

/**
 * Get RPC URL for a specific chain from environment
 * First checks for RPC_<chainId>, then falls back to RPC_URL
 *
 * @param env - Environment variables
 * @param chainId - The chain ID to get RPC for
 * @returns The RPC URL or undefined if not configured
 */
export function getRpcUrl(env: RpcEnv, chainId: number | string): string | undefined {
    const chainIdStr = String(chainId)
    const chainSpecificKey = `RPC_${chainIdStr}` as const

    // First try chain-specific RPC
    const chainSpecificRpc = env[chainSpecificKey]
    if (chainSpecificRpc) {
        return chainSpecificRpc
    }

    // Fall back to default RPC_URL
    return env.RPC_URL
}

/**
 * Get all supported chain IDs from chains.json
 * @returns Array of all chain IDs in the config
 */
export function getSupportedChainIds(): number[] {
    const config = loadChainsConfig()
    return Object.keys(config.chains).map((id) => parseInt(id, 10))
}
