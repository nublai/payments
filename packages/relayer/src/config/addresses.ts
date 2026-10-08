import { requireAddresses, type ContractAddresses } from '@nubl/contracts/deployments'

/**
 * Get contract addresses for a chain from bundled deployments JSON.
 * Env vars (ORCHESTRATOR_<chainId>, or bare ORCHESTRATOR and the other keys)
 * are read only for CONTEXT=local and the Anvil chains. Anywhere else a zero
 * or missing JSON address throws, naming the contract, context, and chain.
 */
export function getContractAddresses(
    env: Record<string, string | undefined>,
    chainId: number,
): ContractAddresses {
    return requireAddresses(env.CONTEXT ?? 'prod', chainId, { env })
}
