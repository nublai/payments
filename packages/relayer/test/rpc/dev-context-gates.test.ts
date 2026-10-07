import { describe, expect, it } from 'vitest'

import { validateEnv } from '../../src/config'
import { requirePaidUpgradeClientIp } from '../../src/rpc/methods/shared/paid-upgrade'
import { INVALID_PARAMS } from '../../src/rpc/errors'
import type { Env } from '../../src/types/env'

function devEnv(overrides: Partial<Env> = {}): Env {
    return {
        RPC_URL: 'http://127.0.0.1:8545',
        CHAIN_IDS: '84532',
        RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
        CONTEXT: 'dev',
        QUOTE_SIGNING_SECRET: 'test-quote-signing-secret',
        PRIVY_ENABLED: 'false',
        ORCHESTRATOR_84532: '0x3456789012345678901234567890123456789012',
        ...overrides,
    } as Env
}

describe('CONTEXT=dev is not local', () => {
    it('refuses a missing client IP and requires FEE_RECIPIENT', () => {
        const request = new Request('https://relayer.example/')
        expect(() => requirePaidUpgradeClientIp(request, { CONTEXT: 'dev' })).toThrow(
            expect.objectContaining({
                code: INVALID_PARAMS,
                message: 'Paid upgrade client IP is required',
            }),
        )
        expect(requirePaidUpgradeClientIp(request, { CONTEXT: 'local' })).toBe('unknown')

        const missing = validateEnv(devEnv({ FEE_RECIPIENT: '' }))
        expect(missing.valid).toBe(false)
        expect(missing.missing).toContain('FEE_RECIPIENT')

        const zero = validateEnv(
            devEnv({ FEE_RECIPIENT: '0x0000000000000000000000000000000000000000' }),
        )
        expect(zero.valid).toBe(false)
        expect(zero.missing).toContain('FEE_RECIPIENT')

        const set = validateEnv(
            devEnv({ FEE_RECIPIENT: '0x1111111111111111111111111111111111111111' }),
        )
        expect(set.missing).not.toContain('FEE_RECIPIENT')
    })
})
