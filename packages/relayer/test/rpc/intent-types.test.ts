import { describe, expect, it } from 'vitest'

import { INTENT_TYPES } from '../../src/rpc/schema/intentTypes'

describe('INTENT_TYPES canonical schema', () => {
    it('matches orchestrator field order and solidity types', () => {
        expect(INTENT_TYPES.Intent).toEqual([
            { name: 'multichain', type: 'bool' },
            { name: 'eoa', type: 'address' },
            { name: 'calls', type: 'Call[]' },
            { name: 'nonce', type: 'uint256' },
            { name: 'payer', type: 'address' },
            { name: 'paymentToken', type: 'address' },
            { name: 'paymentMaxAmount', type: 'uint256' },
            { name: 'combinedGas', type: 'uint256' },
            { name: 'encodedPreCalls', type: 'bytes[]' },
            { name: 'encodedFundTransfers', type: 'bytes[]' },
            { name: 'settler', type: 'address' },
            { name: 'expiry', type: 'uint256' },
        ])
        expect(INTENT_TYPES.Call).toEqual([
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
        ])
    })
})
