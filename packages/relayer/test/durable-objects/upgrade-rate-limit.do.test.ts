import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('SignerPoolDO upgrade rate limit', () => {
    it('allows five upgrades for one account and rejects the next', async () => {
        const poolName = 'pool-8453-c1-rate'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const body = {
            kind: 'upgrade',
            chainId: 8453,
            account: '0x1111111111111111111111111111111111111111',
            ip: '203.0.113.9',
        }

        for (let attempt = 0; attempt < 5; attempt++) {
            const response = await stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            expect(response.ok).toBe(true)
            expect(await response.json()).toEqual({ allowed: true })
        }

        const blocked = await stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        expect(blocked.ok).toBe(true)
        expect(await blocked.json()).toEqual({ allowed: false })
    })
})
