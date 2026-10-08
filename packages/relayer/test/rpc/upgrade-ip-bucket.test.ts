import { describe, expect, it } from 'vitest'

import {
    consumeRateLimit,
    upgradeClientIp,
    upgradeRateBuckets,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'

const CHAIN_ID = 8453

const NOW = 1_700_000_300

function headerIp(value: string): string {
    return upgradeClientIp(
        new Request('https://relayer.example/', { headers: { 'cf-connecting-ip': value } }),
    )
}

function ipBucket(ip: string): string {
    return upgradeRateBuckets({
        kind: 'upgrade',
        chainId: CHAIN_ID,
        account: '0x1111111111111111111111111111111111111111',
        ip,
    })[1].key
}

/** Host `i` inside 2001:db8:1:2::/64, written in a different textual form each time. */
function hostInPrefix(i: number): string {
    const host = i.toString(16)
    const variant = i % 4

    if (variant === 0) return `2001:db8:1:2::${host}`

    if (variant === 1) return `2001:DB8:0001:0002::${host}`

    if (variant === 2) return `2001:0db8:1:2:0:0:0:${host}`

    return `2001:db8:0001:0002:0000:0000:0000:${host}`
}

describe('upgrade IP buckets', () => {
    it('puts a /64 of IPv6 addresses, in any text form, in one bucket', () => {
        const forms = Array.from({ length: 22 }, (_, index) => hostInPrefix(index + 1))
        const keys = forms.map((form) => ipBucket(headerIp(form)))
        expect(new Set(keys).size).toBe(1)

        const limit = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: CHAIN_ID,
            account: '0xabc',
            ip: headerIp(forms[0]),
        })[1].limit

        const store = new Map<string, number>()

        for (let hit = 0; hit < limit; hit++) {
            const buckets = upgradeRateBuckets({
                kind: 'upgrade',
                chainId: CHAIN_ID,
                account: `0x${(hit + 1).toString(16).padStart(40, '0')}`,
                ip: headerIp(forms[hit % forms.length]),
            })

            expect(consumeRateLimit(store, buckets, NOW).allowed).toBe(true)
        }

        const overflow = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: CHAIN_ID,
            account: '0x00000000000000000000000000000000000000aa',
            ip: headerIp('2001:0db8:0001:0002:0000:0000:0000:00ff'),
        })

        expect(consumeRateLimit(store, overflow, NOW).allowed).toBe(false)
        expect(overflow[1].key).toBe(keys[0])
    })

    it('buckets an IPv4-mapped address as its IPv4', () => {
        const v4 = headerIp('203.0.113.9')
        expect(headerIp('::ffff:203.0.113.9')).toBe(v4)
        expect(headerIp('::FFFF:203.0.113.9')).toBe(v4)
        expect(headerIp('0:0:0:0:0:ffff:cb00:7109')).toBe(v4)
        expect(headerIp('0:0:0:0:0:FFFF:203.0.113.9')).toBe(v4)
    })
})
