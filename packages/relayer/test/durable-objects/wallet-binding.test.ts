import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { walletBindingStub } from '../../src/auth/wallet-binding-client'
import type { Env } from '../../src/types/env'

const ISSUER = 'https://binding.example'
const NOW = 1_700_000_000

function stub() {
    return walletBindingStub(env as unknown as Env)
}

describe('WalletBindingDO', () => {
    it('refuses a second sub for the same address', async () => {
        const address = '0x1000000000000000000000000000000000000001'
        const store = stub()
        const first = await store.issueNonce({
            issuer: ISSUER,
            subject: 'sub-a',
            address,
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 600,
        })
        const second = await store.issueNonce({
            issuer: ISSUER,
            subject: 'sub-b',
            address,
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 600,
        })
        expect(first.ok).toBe(true)
        expect(second.ok).toBe(true)
        if (!first.ok || !second.ok) return

        const bound = await store.bind({
            nonce: first.nonce,
            issuer: ISSUER,
            subject: 'sub-a',
            address,
            chainId: 31337,
            expiry: first.expiresAt,
            nowSeconds: NOW,
        })
        const taken = await store.bind({
            nonce: second.nonce,
            issuer: ISSUER,
            subject: 'sub-b',
            address,
            chainId: 31337,
            expiry: second.expiresAt,
            nowSeconds: NOW,
        })

        expect(bound).toEqual({ ok: true })
        expect(taken).toEqual({ ok: false, reason: 'address_taken' })
        expect(await store.ownerOf(address)).toEqual({ issuer: ISSUER, subject: 'sub-a' })

        const later = await store.issueNonce({
            issuer: ISSUER,
            subject: 'sub-c',
            address,
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 600,
        })
        expect(later).toEqual({ ok: false, reason: 'address_taken' })
    })

    it('refuses a reused nonce and an expired nonce', async () => {
        const address = '0x1000000000000000000000000000000000000002'
        const store = stub()
        const issued = await store.issueNonce({
            issuer: ISSUER,
            subject: 'sub-reuse',
            address,
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 600,
        })
        expect(issued.ok).toBe(true)
        if (!issued.ok) return

        const first = await store.bind({
            nonce: issued.nonce,
            issuer: ISSUER,
            subject: 'sub-reuse',
            address,
            chainId: 31337,
            expiry: issued.expiresAt,
            nowSeconds: NOW,
        })
        const reused = await store.bind({
            nonce: issued.nonce,
            issuer: ISSUER,
            subject: 'sub-reuse',
            address,
            chainId: 31337,
            expiry: issued.expiresAt,
            nowSeconds: NOW + 1,
        })
        expect(first).toEqual({ ok: true })
        expect(reused).toEqual({ ok: false, reason: 'nonce_unknown' })

        const expiring = await store.issueNonce({
            issuer: ISSUER,
            subject: 'sub-reuse',
            address: '0x1000000000000000000000000000000000000003',
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 600,
        })
        expect(expiring.ok).toBe(true)
        if (!expiring.ok) return
        const expired = await store.bind({
            nonce: expiring.nonce,
            issuer: ISSUER,
            subject: 'sub-reuse',
            address: '0x1000000000000000000000000000000000000003',
            chainId: 31337,
            expiry: expiring.expiresAt,
            nowSeconds: expiring.expiresAt,
        })
        expect(expired).toEqual({ ok: false, reason: 'nonce_expired' })
    })

    it('lets the same identity bind a second address', async () => {
        const store = stub()
        const firstAddress = '0x1000000000000000000000000000000000000004'
        const secondAddress = '0x1000000000000000000000000000000000000005'
        for (const address of [firstAddress, secondAddress]) {
            const issued = await store.issueNonce({
                issuer: ISSUER,
                subject: 'sub-many',
                address,
                chainId: 31337,
                nowSeconds: NOW,
                ttlSeconds: 600,
            })
            expect(issued.ok).toBe(true)
            if (!issued.ok) return
            const bound = await store.bind({
                nonce: issued.nonce,
                issuer: ISSUER,
                subject: 'sub-many',
                address,
                chainId: 31337,
                expiry: issued.expiresAt,
                nowSeconds: NOW,
            })
            expect(bound).toEqual({ ok: true })
        }

        const accounts = await store.accountsFor(ISSUER, 'sub-many')
        expect(accounts).toEqual([firstAddress, secondAddress])
    })

    it('purges an expired binding and keeps a live one when the runtime calls alarm', async () => {
        const store = stub()
        const nowSeconds = Math.floor(Date.now() / 1000)

        const live = await store.issueNonce({
            issuer: ISSUER,
            subject: 'sub-alarm-live',
            address: '0x10000000000000000000000000000000000000a1',
            chainId: 31337,
            nowSeconds,
            ttlSeconds: 3600,
        })

        const expired = await store.issueNonce({
            issuer: ISSUER,
            subject: 'sub-alarm-expired',
            address: '0x10000000000000000000000000000000000000a2',
            chainId: 31337,
            nowSeconds: nowSeconds - 120,
            ttlSeconds: 60,
        })

        expect(live.ok).toBe(true)
        expect(expired.ok).toBe(true)

        if (!live.ok || !expired.ok) return
        expect(expired.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
        expect(live.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))

        const seen = await runInDurableObject(store, async (instance, state) => {
            const listed = () =>
                state.storage.sql
                    .exec<{ nonce: string }>(
                        `SELECT nonce FROM bind_nonces WHERE nonce = ? OR nonce = ? ORDER BY nonce ASC`,
                        expired.nonce,
                        live.nonce,
                    )
                    .toArray()
                    .map((row) => row.nonce)

            const before = listed()

            await instance.alarm({ scheduledTime: Date.now(), retryCount: 0, isRetry: false })

            return { before, after: listed() }
        })

        expect(seen.before).toEqual([expired.nonce, live.nonce].sort())
        expect(seen.after).toEqual([live.nonce])
    })
})
