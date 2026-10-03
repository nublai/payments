import { afterEach, describe, expect, it, vi } from 'vitest'

import { QUOTE_EXPIRED, RpcError } from '../../src/rpc/errors'
import { validateQuote } from '../../src/rpc/methods/shared/calls-helpers'

describe('validateQuote boundary semantics', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('rejects quote when ttl equals current unix second', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
        const now = Math.floor(Date.now() / 1000)

        const result = await validateQuote(
            {
                quotes: [],
                signature: '0x',
                ttl: now,
            },
            {},
        )

        expect(result).toBeInstanceOf(RpcError)
        expect((result as RpcError).code).toBe(QUOTE_EXPIRED)
    })

    it('accepts quote when ttl is strictly in the future', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
        const now = Math.floor(Date.now() / 1000)

        const result = await validateQuote(
            {
                quotes: [],
                signature: '0x',
                ttl: now + 1,
            },
            {},
        )

        expect(result).toBeNull()
    })
})
