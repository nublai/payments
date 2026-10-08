import { describe, expect, it } from 'vitest'

import { signedPaymentMaxForQuote as clientCap } from '../../../relayer-client/src/helpers/bindPreparedCalls'
import {
    DEFAULT_PAID_UPGRADE_DAILY_GAS_BUDGET,
    DEFAULT_PAID_UPGRADE_GLOBAL_LIMIT,
    DEFAULT_PAID_UPGRADE_MAX_PAYMENT,
    PAID_UPGRADE_GAS_HOLD,
    paidUpgradeDailyGasBudget,
    paidUpgradeGlobalLimit,
    paidUpgradeSignedGas,
    signedPaymentMaxForQuote,
} from '../../src/rpc/methods/shared/paid-upgrade'

describe('paid upgrade quote cap', () => {
    it('matches the relayer-client quote plus 5% helper', () => {
        for (const amount of [1n, 300_000n, 1_357_262n, 1_396_031n]) {
            expect(signedPaymentMaxForQuote(amount)).toBe(clientCap(amount))
        }

        expect(signedPaymentMaxForQuote(300_000n)).toBe(315_000n)
    })

    it('keeps the 5 USDC ceiling and reads configured limits', () => {
        expect(DEFAULT_PAID_UPGRADE_MAX_PAYMENT).toBe(5_000_000n)
        expect(DEFAULT_PAID_UPGRADE_GLOBAL_LIMIT).toBe(60)
        expect(DEFAULT_PAID_UPGRADE_DAILY_GAS_BUDGET).toBe(2_000_000n)
        expect(PAID_UPGRADE_GAS_HOLD).toBe(500_000n)
        expect(paidUpgradeSignedGas(456_207n)).toBe(456_207n)
        expect(paidUpgradeSignedGas(PAID_UPGRADE_GAS_HOLD)).toBe(PAID_UPGRADE_GAS_HOLD)
        expect(() => paidUpgradeSignedGas(809_224n)).toThrow(/reserved hold/)
        expect(paidUpgradeGlobalLimit({ PAID_UPGRADE_GLOBAL_LIMIT: '7' })).toBe(7)
        expect(paidUpgradeDailyGasBudget({ PAID_UPGRADE_DAILY_GAS_BUDGET: '900000' })).toBe(900_000n)
        expect(() => paidUpgradeGlobalLimit({ PAID_UPGRADE_GLOBAL_LIMIT: '0' })).toThrow(
            /PAID_UPGRADE_GLOBAL_LIMIT is invalid/,
        )
        expect(() => paidUpgradeDailyGasBudget({ PAID_UPGRADE_DAILY_GAS_BUDGET: 'nope' })).toThrow(
            /PAID_UPGRADE_DAILY_GAS_BUDGET is invalid/,
        )
    })
})
