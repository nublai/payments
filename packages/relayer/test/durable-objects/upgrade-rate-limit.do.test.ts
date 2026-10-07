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

    it('keeps spent and held inside the daily budget, including four concurrent holds', async () => {
        const poolName = 'pool-8453-paid-gas-ceiling'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const budget = 2_000_000
        const post = (body: Record<string, unknown>) =>
            stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: 'paid-upgrade', chainId: 8453, ...body }),
            })

        const aboveHold = await post({ action: 'reserve-gas', gas: '500001' })
        expect(await aboveHold.json()).toMatchObject({ allowed: false, gas: 0, held: 0 })

        for (let index = 1; index <= 4; index++) {
            const reserved = await post({ action: 'reserve-gas', gas: '500000' })
            expect(await reserved.json()).toMatchObject({ allowed: true, held: index * 500_000 })
        }
        const fifth = await post({ action: 'reserve-gas', gas: '500000' })
        expect(await fifth.json()).toMatchObject({ allowed: false, held: budget })

        let books = { gas: 0, held: budget }
        for (let index = 0; index < 4; index++) {
            const settled = await post({
                action: 'settle-gas',
                hold: '500000',
                gas: '1500000',
            })
            books = (await settled.json()) as { gas: number; held: number }
            expect(books.gas + books.held).toBeLessThanOrEqual(budget)
            expect(books.gas).not.toBe(2_100_000)
        }
        expect(books).toMatchObject({ gas: budget, held: 0 })
        const blocked = await post({ action: 'reserve-gas', gas: '500000' })
        expect(await blocked.json()).toMatchObject({ allowed: false, gas: budget, held: 0 })
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

    it('records the replacement gasUsed once and does not release while that hash is pending', async () => {
        const poolName = 'pool-8453-paid-replacement-mines'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const original = `0x${'ab'.repeat(32)}`
        const replacement = `0x${'cd'.repeat(32)}`
        const post = (body: Record<string, unknown>) =>
            stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: 'paid-upgrade',
                    chainId: 8453,
                    nonce: 7,
                    signerName: 'signer-8453-0',
                    ...body,
                }),
            })

        expect(await (await post({ action: 'reserve-gas', gas: '500000' })).json()).toMatchObject({
            allowed: true,
            held: 500000,
        })
        expect(await (await post({ action: 'enqueue-receipt', txHash: original })).json()).toMatchObject({
            allowed: true,
        })
        expect(
            await (await post({ action: 'enqueue-receipt', txHash: replacement })).json(),
        ).toMatchObject({ allowed: true })

        const missing = await post({
            action: 'reconcile-receipt',
            txHash: original,
            found: false,
        })
        expect(await missing.json()).toMatchObject({ allowed: true, gas: 0, held: 500000 })

        const mined = await post({
            action: 'reconcile-receipt',
            txHash: replacement,
            found: true,
            gas: '350809',
            failure: false,
        })
        expect(await mined.json()).toMatchObject({ allowed: true, gas: 350809, held: 0 })
        const again = await post({
            action: 'reconcile-receipt',
            txHash: replacement,
            found: true,
            gas: '350809',
            failure: false,
        })
        expect(await again.json()).toMatchObject({ allowed: true, gas: 350809, held: 0 })
    })

    it('does not release the hold when the original hash is missing and the replacement is pending', async () => {
        const poolName = 'pool-8453-paid-replacement-pending'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const original = `0x${'ef'.repeat(32)}`
        const replacement = `0x${'12'.repeat(32)}`
        const post = (body: Record<string, unknown>) =>
            stub.fetch(`http://do/upgrade-rate-limit?poolName=${poolName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: 'paid-upgrade',
                    chainId: 8453,
                    nonce: 4,
                    signerName: 'signer-8453-1',
                    ...body,
                }),
            })

        expect(await (await post({ action: 'reserve-gas', gas: '500000' })).json()).toMatchObject({
            allowed: true,
            held: 500000,
        })
        expect(await (await post({ action: 'enqueue-receipt', txHash: original })).json()).toMatchObject({
            allowed: true,
        })
        expect(
            await (await post({ action: 'enqueue-receipt', txHash: replacement })).json(),
        ).toMatchObject({ allowed: true })
        const missing = await post({
            action: 'reconcile-receipt',
            txHash: original,
            found: false,
        })
        expect(await missing.json()).toMatchObject({ allowed: true, gas: 0, held: 500000 })
    })

    it('does not release a fee pull when its replacement for the same nonce is still pending', async () => {
        const poolName = 'pool-8453-fee-pull-replacement'
        const id = env.SIGNER_POOL.idFromName(poolName)
        const stub = env.SIGNER_POOL.get(id)
        const original = `0x${'44'.repeat(32)}`
        const replacement = `0x${'55'.repeat(32)}`
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
        expect(
            await (
                await post({
                    action: 'enqueue-receipt',
                    txHash: original,
                    nonce: 4,
                    signerName: 'signer-8453-0',
                })
            ).json(),
        ).toMatchObject({ allowed: true })
        expect(
            await (
                await post({
                    action: 'track-replacement',
                    priorHash: original,
                    txHash: replacement,
                    nonce: 4,
                    signerName: 'signer-8453-0',
                })
            ).json(),
        ).toMatchObject({ allowed: true, held: 500000 })
        const missing = await post({
            action: 'reconcile-receipt',
            txHash: original,
            found: false,
        })
        expect(await missing.json()).toMatchObject({ allowed: true, gas: 0, held: 500000 })
        const mined = await post({
            action: 'reconcile-receipt',
            txHash: replacement,
            found: true,
            gas: '600000',
            failure: false,
        })
        expect(await mined.json()).toMatchObject({ allowed: true, gas: 500000, held: 0 })
    })
})
