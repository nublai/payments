import { describe, expect, it } from 'vitest'
import { calculateCombinedGas, isPaymentEnabled } from '../src/services/relayer'

describe('relayer gas helpers', () => {
    it('detects payment-enabled intents only when both payer and token are set', () => {
        expect(
            isPaymentEnabled(
                '0x1111111111111111111111111111111111111111',
                '0x2222222222222222222222222222222222222222',
            ),
        ).toBe(true)

        expect(
            isPaymentEnabled(
                '0x0000000000000000000000000000000000000000',
                '0x2222222222222222222222222222222222222222',
            ),
        ).toBe(false)

        expect(
            isPaymentEnabled(
                '0x1111111111111111111111111111111111111111',
                '0x0000000000000000000000000000000000000000',
            ),
        ).toBe(false)
    })

    it('adds paymentGasBuffer only for payment-enabled intents', () => {
        const simulationGas = 200_000n

        const gasConfig = {
            intentGasBuffer: 50_000n,
            paymentGasBuffer: 70_000n,
        }

        expect(calculateCombinedGas(simulationGas, gasConfig, false)).toBe(250_000n)
        expect(calculateCombinedGas(simulationGas, gasConfig, true)).toBe(320_000n)
    })
})
