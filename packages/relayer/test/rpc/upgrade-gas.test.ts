import { describe, expect, it } from 'vitest'

import {
    ACCOUNT_UPGRADE_GAS_LIMIT,
    ACCOUNT_UPGRADE_MAX_FEE_PER_GAS,
    assertAccountUpgradeGas,
} from '../../src/rpc/methods/shared/upgrade-gas'

describe('account upgrade gas cap', () => {
    it('refuses the 5000000 gas bomb and an uncapped max fee before signing', () => {
        expect(() =>
            assertAccountUpgradeGas({
                gas: 5_000_000n,
                maxFeePerGas: 2_200_000_000n,
                maxPriorityFeePerGas: 1_000_000_000n,
            }),
        ).toThrow(/gas limit exceeds cap/)

        expect(() =>
            assertAccountUpgradeGas({
                gas: 46_018n,
                maxFeePerGas: ACCOUNT_UPGRADE_MAX_FEE_PER_GAS + 1n,
                maxPriorityFeePerGas: 1n,
            }),
        ).toThrow(/max fee exceeds cap/)

        const allowed = assertAccountUpgradeGas({
            gas: 46_018n,
            maxFeePerGas: 2_200_000_000n,
            maxPriorityFeePerGas: 1_000_000_000n,
        })
        expect(allowed.gas).toBe(46_018n)
        expect(allowed.gas).toBeLessThanOrEqual(ACCOUNT_UPGRADE_GAS_LIMIT)
    })
})
