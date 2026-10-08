import { afterEach, expect, test } from 'bun:test'
import { resolveEscrowContracts } from '../src/lib/escrow-common'
import { resolveOrchestratorAddress } from '../src/lib/orchestrator-address'

// Same keys the deleted envs/prod/.env exported. The values stand in for the
// old Towns addresses that file held.
const staleEnv = {
    ORCHESTRATOR_8453: '0x1000000000000000000000000000000000000005',
    ACCOUNT_8453: '0x1000000000000000000000000000000000000001',
    ACCOUNT_PROXY_8453: '0x1000000000000000000000000000000000000002',
    ESCROW_8453: '0x1000000000000000000000000000000000000003',
    MULTI_SIG_SIGNER_8453: '0x1000000000000000000000000000000000000004',
    SIMPLE_FUNDER_8453: '0x1000000000000000000000000000000000000006',
    SIMPLE_SETTLER_8453: '0x1000000000000000000000000000000000000007',
    SIMULATOR_8453: '0x1000000000000000000000000000000000000008',
}

const previous = new Map<string, string | undefined>()

function installStaleEnv(): void {
    for (const [key, value] of Object.entries(staleEnv)) {
        previous.set(key, process.env[key])
        process.env[key] = value
    }
}

afterEach(() => {
    for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }

    previous.clear()
})

test('prod/8453 orchestrator throws instead of using ORCHESTRATOR_8453 from env', () => {
    installStaleEnv()

    expect(() => resolveOrchestratorAddress('prod', 8453)).toThrow(/prod\/8453/)
})

test('prod/8453 escrow throws instead of using ESCROW_8453 from env', () => {
    installStaleEnv()

    expect(() => resolveEscrowContracts('prod', 8453, 'base')).toThrow(/prod\/8453/)
})
