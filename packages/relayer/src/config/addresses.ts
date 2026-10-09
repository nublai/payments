import { requireAddresses, type ContractAddresses } from '@nubl/contracts/deployments'

const ADDRESS_ENV_KEYS = [
    'ORCHESTRATOR',
    'SIMPLE_FUNDER',
    'SIMPLE_SETTLER',
    'SIMULATOR',
    'ACCOUNT',
    'ACCOUNT_PROXY',
    'ESCROW',
    'MULTI_SIG_SIGNER',
] as const

type AddressEnvKey = (typeof ADDRESS_ENV_KEYS)[number]

/** Worker or test env fields that `requireAddresses` reads for a chain. */

export type ContractAddressEnv = {
    CONTEXT?: string
} & { [K in AddressEnvKey]?: string } & {
    [K in `${AddressEnvKey}_${string}`]?: string
}

function addressEnvVars(env: ContractAddressEnv, chainId: number) {
    return {
        CONTEXT: env.CONTEXT,
        ORCHESTRATOR: env.ORCHESTRATOR,
        SIMPLE_FUNDER: env.SIMPLE_FUNDER,
        SIMPLE_SETTLER: env.SIMPLE_SETTLER,
        SIMULATOR: env.SIMULATOR,
        ACCOUNT: env.ACCOUNT,
        ACCOUNT_PROXY: env.ACCOUNT_PROXY,
        ESCROW: env.ESCROW,
        MULTI_SIG_SIGNER: env.MULTI_SIG_SIGNER,
        [`ORCHESTRATOR_${chainId}`]: env[`ORCHESTRATOR_${chainId}`],
        [`SIMPLE_FUNDER_${chainId}`]: env[`SIMPLE_FUNDER_${chainId}`],
        [`SIMPLE_SETTLER_${chainId}`]: env[`SIMPLE_SETTLER_${chainId}`],
        [`SIMULATOR_${chainId}`]: env[`SIMULATOR_${chainId}`],
        [`ACCOUNT_${chainId}`]: env[`ACCOUNT_${chainId}`],
        [`ACCOUNT_PROXY_${chainId}`]: env[`ACCOUNT_PROXY_${chainId}`],
        [`ESCROW_${chainId}`]: env[`ESCROW_${chainId}`],
        [`MULTI_SIG_SIGNER_${chainId}`]: env[`MULTI_SIG_SIGNER_${chainId}`],
    }
}

/**
 * Get contract addresses for a chain from bundled deployments JSON.
 * Env vars (ORCHESTRATOR_<chainId>, or bare ORCHESTRATOR and the other keys)
 * are read only for CONTEXT=local and the Anvil chains. Anywhere else a zero
 * or missing JSON address throws, naming the contract, context, and chain.
 */
export function getContractAddresses(env: ContractAddressEnv, chainId: number): ContractAddresses {
    return requireAddresses(env.CONTEXT ?? 'prod', chainId, {
        env: addressEnvVars(env, chainId),
    })
}
