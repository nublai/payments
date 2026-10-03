import { z } from 'zod'
import type { Address } from 'viem'

/**
 * Native currency configuration for a chain
 */
export const NativeCurrencySchema = z.object({
    name: z.string(),
    symbol: z.string(),
    decimals: z.number().int().positive(),
})

export type NativeCurrency = z.infer<typeof NativeCurrencySchema>

/**
 * Asset configuration for a chain
 */
export const AssetConfigSchema = z.object({
    /** Contract address (0x0...0 for native token) */
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    /** Token decimals */
    decimals: z.number().int().nonnegative(),
    /** Whether this asset can be used to pay fees */
    feeToken: z.boolean(),
    /** Whether this asset supports cross-chain interop (e.g., USDC via LayerZero) */
    interop: z.boolean(),
})

export type AssetConfig = z.infer<typeof AssetConfigSchema>

/**
 * Full configuration for a single chain
 */
export const ChainConfigSchema = z.object({
    /** Human-readable chain name (e.g., "base-sepolia") */
    name: z.string(),
    /** Whether this is a testnet */
    isTestnet: z.boolean(),
    /** Native currency info */
    nativeCurrency: NativeCurrencySchema,
    /** Supported assets keyed by canonical name (e.g., "eth", "usdc") */
    assets: z.record(z.string(), AssetConfigSchema),
})

export type ChainConfig = z.infer<typeof ChainConfigSchema>

/**
 * Root configuration schema for chains.json
 */
export const ChainsConfigSchema = z.object({
    /** Config version for compatibility checks */
    version: z.string(),
    /** Chain configurations keyed by chain ID */
    chains: z.record(z.string(), ChainConfigSchema),
})

export type ChainsConfig = z.infer<typeof ChainsConfigSchema>

/**
 * Typed asset config with address as viem Address type
 */
export interface TypedAssetConfig extends Omit<AssetConfig, 'address'> {
    address: Address
}

/**
 * Typed chain config with addresses as viem Address types
 */
export interface TypedChainConfig extends Omit<ChainConfig, 'assets'> {
    assets: Record<string, TypedAssetConfig>
}
