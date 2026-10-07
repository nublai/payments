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

/**
 * Orchestrator used as the EIP-712 verifying contract.
 * Published chains come from deployments JSON. Local Anvil (31337) reads
 * ORCHESTRATOR_31337 from the process env or the local deploy env file.
 */
export function resolveOrchestratorAddress(env: EnvName, chainId: number): Address {
    const fromJson = getAddresses(env, chainId)?.orchestrator
    if (fromJson) return getAddress(fromJson)

    if (chainId === 31337 || chainId === 41337) {
        const key = `ORCHESTRATOR_${chainId}`
        const raw = readDeployEnvValue(key)
        if (raw) return getAddress(raw)
        throw new Error(
            `No orchestrator for local chain ${chainId}. Set ${key} from the local deploy env (packages/contracts/deployments/envs/local/.env).`,
        )
    }

    throw new Error(`No orchestrator deployment for ${env}/${chainId}.`)
}
