import type { Env } from '../../../types/env'

/**
 * Get SignerPoolDO stub for the current chain.
 */
export function getSignerPool(env: Env, chainId: number): DurableObjectStub {
    const poolId = env.SIGNER_POOL.idFromName(`pool-${chainId}`)

    return env.SIGNER_POOL.get(poolId)
}
