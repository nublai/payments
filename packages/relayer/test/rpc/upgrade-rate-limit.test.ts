import { describe, expect, it } from 'vitest'

import {
    consumeRateLimit,
    rateWindowId,
    rateWindowStart,
    upgradeRateBuckets,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'

describe('upgrade rate limit', () => {
    it('allows calls up to the account cap and then rejects without incrementing', () => {
        const buckets = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: 8453,
            account: '0xABC',
            ip: '203.0.113.5',
        })
        const accountBucket = buckets[0]
        expect(accountBucket.limit).toBe(5)

        const store = new Map<string, number>()
        const now = 1_700_000_000
        for (let i = 0; i < accountBucket.limit; i++) {
            expect(consumeRateLimit(store, buckets, now).allowed).toBe(true)
        }

        expect(consumeRateLimit(store, buckets, now).allowed).toBe(false)
        const windowStart = rateWindowStart(now, accountBucket.windowSeconds)
        expect(store.get(rateWindowId(accountBucket.key, windowStart))).toBe(accountBucket.limit)
    })

    it('resets the account bucket in the next window', () => {
        const buckets = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: 8453,
            account: '0xABC',
            ip: '203.0.113.5',
        })
        const store = new Map<string, number>()
        const now = 1_700_000_000
        for (let i = 0; i < buckets[0].limit; i++) {
            consumeRateLimit(store, buckets, now)
        }

        const nextWindow = now + buckets[0].windowSeconds
        expect(consumeRateLimit(store, buckets, nextWindow).allowed).toBe(true)
    })

    it('counts prepare and upgrade separately', () => {
        const store = new Map<string, number>()
        const now = 1_700_000_100
        const shared = {
            chainId: 31337,
            account: '0x1111111111111111111111111111111111111111',
            ip: 'unknown',
        }
        const upgrade = upgradeRateBuckets({ kind: 'upgrade', ...shared })
        const prepare = upgradeRateBuckets({ kind: 'prepare', ...shared })

        for (let i = 0; i < upgrade[0].limit; i++) {
            expect(consumeRateLimit(store, upgrade, now).allowed).toBe(true)
        }
        expect(consumeRateLimit(store, upgrade, now).allowed).toBe(false)
        expect(consumeRateLimit(store, prepare, now).allowed).toBe(true)
    })

    it('rejects at the global cap before a fresh account is exhausted', () => {
        const store = new Map<string, number>()
        const now = 1_700_000_200
        const globalBucket = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: 8453,
            account: '0x0000000000000000000000000000000000000001',
            ip: '198.51.100.2',
        })[2]

        for (let i = 0; i < globalBucket.limit; i++) {
            const account = `0x${(i + 1).toString(16).padStart(40, '0')}`
            const buckets = upgradeRateBuckets({
                kind: 'upgrade',
                chainId: 8453,
                account,
                ip: `198.51.100.${(i % 200) + 1}`,
            })
            expect(consumeRateLimit(store, buckets, now).allowed).toBe(true)
        }

        const overflow = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: 8453,
            account: '0x00000000000000000000000000000000000000aa',
            ip: '198.51.100.9',
        })
        expect(consumeRateLimit(store, overflow, now).allowed).toBe(false)
    })
})
