import { describe, expect, it } from 'vitest'
import { getAddressesWithFallback } from '@nubl/contracts/deployments'

import { getContractAddresses } from '../src/config/addresses'

// Same keys the deleted envs/{dev,stage,prod}/.env files exported. The values
// stand in for the old Towns addresses those files held.
const suffixed8453 = {
    ACCOUNT_8453: '0x1000000000000000000000000000000000000001',
    ACCOUNT_PROXY_8453: '0x1000000000000000000000000000000000000002',
    ESCROW_8453: '0x1000000000000000000000000000000000000003',
    MULTI_SIG_SIGNER_8453: '0x1000000000000000000000000000000000000004',
    ORCHESTRATOR_8453: '0x1000000000000000000000000000000000000005',
    SIMPLE_FUNDER_8453: '0x1000000000000000000000000000000000000006',
    SIMPLE_SETTLER_8453: '0x1000000000000000000000000000000000000007',
    SIMULATOR_8453: '0x1000000000000000000000000000000000000008',
}

const unsuffixed = {
    ACCOUNT: '0x2000000000000000000000000000000000000001',
    ACCOUNT_PROXY: '0x2000000000000000000000000000000000000002',
    ESCROW: '0x2000000000000000000000000000000000000003',
    MULTI_SIG_SIGNER: '0x2000000000000000000000000000000000000004',
    ORCHESTRATOR: '0x2000000000000000000000000000000000000005',
    SIMPLE_FUNDER: '0x2000000000000000000000000000000000000006',
    SIMPLE_SETTLER: '0x2000000000000000000000000000000000000007',
    SIMULATOR: '0x2000000000000000000000000000000000000008',
}

describe('zero address in deployments JSON', () => {
    it('relayer throws for stage/8453 instead of using ORCHESTRATOR_8453 from env', () => {
        expect(() => getContractAddresses({ CONTEXT: 'stage', ...suffixed8453 }, 8453)).toThrow(
            /orchestrator is not deployed for stage\/8453/,
        )
    })

    it('relayer throws for dev/84532 instead of using a bare ORCHESTRATOR from env', () => {
        expect(() => getContractAddresses({ CONTEXT: 'dev', ...unsuffixed }, 84532)).toThrow(
            /orchestrator is not deployed for dev\/84532/,
        )
    })

    it('@nubl/contracts does not resolve prod/8453 from env', () => {
        expect(getAddressesWithFallback('prod', 8453, { env: suffixed8453 })).toBeUndefined()
    })
})
