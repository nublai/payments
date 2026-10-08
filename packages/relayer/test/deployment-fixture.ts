import {
    getAddressesFromEnv,
    getAddressesFromEnvForChain,
    getDeployment,
} from '@nubl/contracts/deployments'

/**
 * Writes test addresses into the bundled deployments JSON for one published
 * context and chain, as a first deploy would. Off local, env vars are not read,
 * so tests that exercise prod behavior install their addresses here.
 * `env` uses the env key names: ORCHESTRATOR_<chainId> and the other suffixed
 * keys, or bare ORCHESTRATOR and the others. Returns a restore function.
 */
export function installDeployment(
    context: string,
    chainId: number,
    env: Record<string, string | undefined>,
): () => void {
    const deployment = getDeployment(context, chainId)

    if (!deployment) throw new Error(`addresses.json has no ${context}/${chainId} entry`)

    const addresses = getAddressesFromEnvForChain(chainId, { env }) ?? getAddressesFromEnv({ env })

    if (!addresses) throw new Error(`test env has no addresses for ${context}/${chainId}`)

    const previous = deployment.addresses
    deployment.addresses = { ...addresses }

    return () => {
        deployment.addresses = previous
    }
}
