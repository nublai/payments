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

    it('releases a reservation that never reached send', async () => {
        const poolName = 'pool-8453-c1-release'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const body = {
            action: 'reserve',
            kind: 'upgrade',
            chainId: 8453,
            account: '0x2222222222222222222222222222222222222222',
            ip: '203.0.113.10',
        }

        let reservedAt = 0
        for (let attempt = 0; attempt < 5; attempt++) {
            const response = await stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const result = (await response.json()) as { allowed?: boolean; reservedAt?: number }
            expect(result.allowed).toBe(true)
            reservedAt = result.reservedAt ?? reservedAt
        }

        const blocked = await stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        expect(await blocked.json()).toEqual({ allowed: false })

        const released = await stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, action: 'release', reservedAt }),
        })
        expect(await released.json()).toEqual({ allowed: true })

        const again = await stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        expect(await again.json()).toMatchObject({ allowed: true })
    })

    it('refuses a paid upgrade that does not name an IP', async () => {
        const poolName = 'pool-8453-paid-no-ip'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const response = await stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'peek',
                kind: 'paid-upgrade',
                chainId: 8453,
                account: '0x3333333333333333333333333333333333333333',
            }),
        })
        expect(response.ok).toBe(true)
        expect(await response.json()).toEqual({ allowed: false })
    })

    it('counts a settled PaymentError against the daily gas budget', async () => {
        const poolName = 'pool-8453-paid-gas'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const post = (body: Record<string, unknown>) =>
            stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'paid-upgrade', chainId: 8453, ...body }),
            })

        const reserved = await post({ action: 'reserve-gas', gas: '500000' })
        expect(await reserved.json()).toMatchObject({ allowed: true })

        const settled = await post({
            action: 'settle-gas',
            hold: '500000',
            gas: '60478',
            failure: true,
        })
        expect(await settled.json()).toMatchObject({ allowed: true, gas: 60478, failures: 1 })

        for (let attempt = 0; attempt < 3; attempt++) {
            const next = await post({ action: 'reserve-gas', gas: '500000' })
            expect(await next.json()).toMatchObject({ allowed: true })
        }
        const blocked = await post({ action: 'reserve-gas', gas: '500000' })
        expect(await blocked.json()).toMatchObject({ allowed: false })
    })

    it('rechecks the budget when a receipt settles above the hold', async () => {
        const poolName = 'pool-8453-paid-gas-over'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const post = (body: Record<string, unknown>) =>
            stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'paid-upgrade', chainId: 8453, ...body }),
            })

        expect(await (await post({ action: 'reserve-gas', gas: '500000' })).json()).toMatchObject({
            allowed: true,
        })
        expect(
            await (
                await post({ action: 'settle-gas', hold: '500000', gas: '1500000' })
            ).json(),
        ).toMatchObject({ allowed: true, gas: 1500000 })
        expect(await (await post({ action: 'reserve-gas', gas: '500000' })).json()).toMatchObject({
            allowed: true,
        })
        const over = await post({ action: 'settle-gas', hold: '500000', gas: '600000' })
        expect(await over.json()).toMatchObject({ allowed: false, overBudget: true, gas: 2100000 })
        const blocked = await post({ action: 'reserve-gas', gas: '500000' })
        expect(await blocked.json()).toMatchObject({ allowed: false })
    })

    it('settles one receipt once and releases a hold when the reconciler finds no transaction', async () => {
        const poolName = 'pool-8453-paid-reconcile'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const txHash = `0x${'11'.repeat(32)}`
        const post = (body: Record<string, unknown>) =>
            stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'paid-upgrade', chainId: 8453, ...body }),
            })

        expect(await (await post({ action: 'reserve-gas', gas: '500000' })).json()).toMatchObject({
            allowed: true,
            held: 500000,
        })
        expect(await (await post({ action: 'enqueue-receipt', txHash })).json()).toMatchObject({
            allowed: true,
        })
        const settled = await post({
            action: 'reconcile-receipt',
            txHash,
            found: true,
            gas: '60478',
            failure: true,
        })
        expect(await settled.json()).toMatchObject({ allowed: true, gas: 60478, failures: 1, held: 0 })
        const again = await post({
            action: 'reconcile-receipt',
            txHash,
            found: true,
            gas: '60478',
            failure: true,
        })
        expect(await again.json()).toMatchObject({ allowed: true, gas: 60478, failures: 1, held: 0 })

        expect(await (await post({ action: 'reserve-gas', gas: '500000' })).json()).toMatchObject({
            allowed: true,
        })
        const missingHash = `0x${'22'.repeat(32)}`
        expect(
            await (await post({ action: 'enqueue-receipt', txHash: missingHash })).json(),
        ).toMatchObject({ allowed: true })
        const released = await post({
            action: 'reconcile-receipt',
            txHash: missingHash,
            found: false,
        })
        expect(await released.json()).toMatchObject({ allowed: true, held: 0 })
        const releasedAgain = await post({
            action: 'reconcile-receipt',
            txHash: missingHash,
            found: false,
        })
        expect(await releasedAgain.json()).toMatchObject({ allowed: true, held: 0 })
    })
})
