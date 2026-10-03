import { describe, expect, it } from 'vitest'

import { resolveIntentExpirySeconds } from '../src/services/relayer'

describe('prepareIntent expiry unit guard', () => {
    const now = 1_700_000_000n

    it('accepts valid expiry values in unix seconds', () => {
        const expiry = resolveIntentExpirySeconds('1700000123', now)
        expect(expiry).toBe(1_700_000_123n)
    })

    it('uses default expiry window when expiry is omitted', () => {
        const expiry = resolveIntentExpirySeconds(undefined, now)
        expect(expiry).toBe(now + 3600n)
    })

    it('rejects millisecond-based expiry values with clear error', () => {
        expect(() => resolveIntentExpirySeconds('1700000000000', now)).toThrow(
            'appears to be milliseconds',
        )
    })
})
