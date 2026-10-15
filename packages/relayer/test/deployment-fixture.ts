import {
    deployments,
    type ChainDeployment,
    getAddressesFromEnv,
    getAddressesFromEnvForChain,
} from '@nubl/contracts/deployments'

type DeploymentBook = Record<string, Record<string, ChainDeployment>>

/**
 * Writes test addresses into the bundled deployments JSON for one published
 * context and chain, as a first deploy would. Off local, env vars are not read,
 * so tests that exercise prod behavior install their addresses here.
 * `env` uses the env key names: ORCHESTRATOR_<chainId> and the other suffixed
 * keys, or bare ORCHESTRATOR and the others. Returns a restore function.
 * A missing context/chain (after the zero-address placeholders were pruned)
 * is created, then removed on restore.
 */
export function installDeployment(
    context: string,
    chainId: number,
    env: Record<string, string | undefined>,
): () => void {
    const addresses = getAddressesFromEnvForChain(chainId, { env }) ?? getAddressesFromEnv({ env })

    if (!addresses) throw new Error(`test env has no addresses for ${context}/${chainId}`)

    // SAFETY: tests mutate the bundled addresses.json object; make-config shape.
    const book = deployments as DeploymentBook
    const byChain = (book[context] ??= {})
    const key = String(chainId)
    const previous = byChain[key]
    byChain[key] = { addresses: { ...addresses } }

    return () => {
        if (previous === undefined) delete byChain[key]
        else byChain[key] = previous

        if (Object.keys(byChain).length === 0) delete book[context]
    }
}
