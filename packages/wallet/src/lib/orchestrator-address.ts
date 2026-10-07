import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getAddress, type Address } from 'viem'
import { getAddresses } from '@nubl/contracts/deployments'
import type { EnvName } from './network-config'

function readDeployEnvValue(name: string): string | undefined {
    const fromProcess = process.env[name]?.trim()
    if (fromProcess) return fromProcess

    const candidates = [
        new URL('../../../contracts/deployments/envs/local/.env', import.meta.url),
        new URL('../../../../contracts/deployments/envs/local/.env', import.meta.url),
    ]
    for (const candidate of candidates) {
        const path = fileURLToPath(candidate)
        if (!existsSync(path)) continue
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const eq = trimmed.indexOf('=')
            if (eq <= 0 || trimmed.slice(0, eq).trim() !== name) continue
            const value = trimmed
                .slice(eq + 1)
                .trim()
                .replace(/^["']|["']$/g, '')
            if (value) return value
        }
    }
    return undefined
}

function resolveLocalOrPublished(
    env: EnvName,
    chainId: number,
    field: 'orchestrator' | 'accountProxy',
    envPrefix: 'ORCHESTRATOR' | 'ACCOUNT_PROXY',
    label: string,
): Address {
    const fromJson = getAddresses(env, chainId)?.[field]
    if (fromJson) return getAddress(fromJson)

    if (chainId === 31337 || chainId === 41337) {
        const key = `${envPrefix}_${chainId}`
        const raw = readDeployEnvValue(key)
        if (raw) return getAddress(raw)
        throw new Error(
            `No ${label} for local chain ${chainId}. Set ${key} from the local deploy env (packages/contracts/deployments/envs/local/.env).`,
        )
    }

    throw new Error(`No ${label} deployment for ${env}/${chainId}. Refusing to continue.`)
}

/**
 * Orchestrator used as the EIP-712 verifying contract.
 * Published chains come from deployments JSON. Local Anvil (31337) reads
 * ORCHESTRATOR_31337 from the process env or the local deploy env file.
 */
export function resolveOrchestratorAddress(env: EnvName, chainId: number): Address {
    return resolveLocalOrPublished(env, chainId, 'orchestrator', 'ORCHESTRATOR', 'orchestrator')
}

/**
 * EIP-7702 delegation target. Published chains come from deployments JSON.
 * Local Anvil reads ACCOUNT_PROXY_31337 or ACCOUNT_PROXY_41337. Unknown chains throw.
 */
export function resolveAccountProxyAddress(env: EnvName, chainId: number): Address {
    return resolveLocalOrPublished(env, chainId, 'accountProxy', 'ACCOUNT_PROXY', 'account proxy')
}
