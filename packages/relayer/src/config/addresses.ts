import {
    getAddresses,
    getAddressesFromEnv,
    getAddressesFromEnvForChain,
    type ContractAddresses,
} from '@nubl/contracts/deployments'

/**
 * Environment variables that can override contract addresses.
 * Names match the contracts package env var keys (no _ADDRESS suffix).
 */
interface AddressEnvOverrides {
    ACCOUNT?: string
    ORCHESTRATOR?: string
    SIMPLE_FUNDER?: string
    SIMULATOR?: string
    ACCOUNT_PROXY?: string
    SIMPLE_SETTLER?: string
    ESCROW?: string
    MULTI_SIG_SIGNER?: string
    CONTEXT?: string
    [key: string]: string | undefined
}

/**
 * Get contract addresses for a chain, with environment variable overrides.
 * Uses getAddressesWithFallback from @nubl/contracts which:
 * 1. Tries bundled deployment JSON first
 * 2. Falls back to env vars for local contexts
 */
export function getContractAddresses(
    env: AddressEnvOverrides & Record<string, string | undefined>,
    chainId: number,
): ContractAddresses {
    const context = env.CONTEXT ?? 'prod'
    const fromJson = getAddresses(context, chainId)
    if (fromJson) {
        return fromJson
    }

    const fromChainEnv = getAddressesFromEnvForChain(chainId, {
        env: env as Record<string, string | undefined>,
    })
    if (fromChainEnv) {
        return fromChainEnv
    }

    const fromEnv = getAddressesFromEnv({
        env: env as Record<string, string | undefined>,
    })
    if (fromEnv) {
        return fromEnv
    }

    throw new Error(
        `No deployment found for ${context}/${chainId}: contracts are not deployed and ORCHESTRATOR_${chainId} not set`,
    )
}
