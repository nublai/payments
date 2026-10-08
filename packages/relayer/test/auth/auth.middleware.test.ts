import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { Address } from 'viem'

import type { Env } from '../../src/types/env'
import { authMiddleware } from '../../src/auth/middleware'
import { upgradeRateIdentity } from '../../src/auth/identity'
import type { AuthProvider } from '../../src/auth/types'

function createEnv(overrides: Partial<Env> = {}): Env {
    return {
        SIGNER: {} as Env['SIGNER'],
        SIGNER_POOL: {} as Env['SIGNER_POOL'],
        INTENT_NONCE_MANAGER: {} as Env['INTENT_NONCE_MANAGER'],
        MONITOR_QUEUE: {} as Env['MONITOR_QUEUE'],
        RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
        CHAIN_IDS: '8453',
        AUTH_PROTECTED_METHODS: 'wallet_sendPreparedCalls,wallet_prepareCalls',
        ...overrides,
    }
}

function makeProvider(name: string, verifyFn: AuthProvider['verify']): AuthProvider {
    return {
        name,
        enabled: () => true,
        verify: verifyFn,
    }
}

function createApp(providers: AuthProvider[]) {
    const app = new Hono<{ Bindings: Env }>()
    app.use('*', authMiddleware({ providers }))
    app.post('/', (c) => c.json({ ok: true }))

    return app
}

describe('auth middleware', () => {
    it('passes unprotected method without auth', async () => {
        const app = createApp([
            makeProvider('privy', async () => ({ ok: false, code: 'INVALID_TOKEN', message: 'x' })),
        ])

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_health',
                    params: [],
                }),
            },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
    })

    it('passes protected method via Privy only', async () => {
        const app = createApp([
            makeProvider('privy', async () => ({ ok: true })),
            makeProvider('erc8128', async () => ({
                ok: false,
                code: 'BAD_SIGNATURE',
                message: 'x',
            })),
        ])

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_sendPreparedCalls',
                    params: [],
                }),
            },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
    })

    it('passes protected method via ERC-8128 only', async () => {
        const app = createApp([
            makeProvider('privy', async () => ({ ok: false, code: 'INVALID_TOKEN', message: 'x' })),
            makeProvider('erc8128', async () => ({ ok: true })),
        ])

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'abc',
                    method: 'wallet_sendPreparedCalls',
                    params: [],
                }),
            },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
    })

    it('returns JSON-RPC unauthorized for protected method when both providers fail', async () => {
        const app = createApp([
            makeProvider('privy', async () => ({
                ok: false,
                code: 'INVALID_TOKEN',
                message: 'invalid',
            })),
            makeProvider('erc8128', async () => ({
                ok: false,
                code: 'BAD_SIGNATURE',
                message: 'bad sig',
            })),
        ])

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 7,
                    method: 'wallet_sendPreparedCalls',
                    params: [],
                }),
            },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            jsonrpc: '2.0',
            id: 7,
            error: {
                code: -32001,
                message: 'Unauthorized',
                data: {
                    auth_code: 'INVALID_TOKEN',
                },
            },
        })
    })

    it('returns unauthorized with id:null for mixed batch when auth fails', async () => {
        const app = createApp([
            makeProvider('privy', async () => ({
                ok: false,
                code: 'INVALID_TOKEN',
                message: 'invalid',
            })),
        ])

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([
                    { jsonrpc: '2.0', id: 1, method: 'wallet_health', params: [] },
                    { jsonrpc: '2.0', id: 2, method: 'wallet_sendPreparedCalls', params: [] },
                ]),
            },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            jsonrpc: '2.0',
            id: null,
            error: {
                code: -32001,
                message: 'Unauthorized',
                data: {
                    auth_code: 'INVALID_TOKEN',
                },
            },
        })
    })

    it('passes mixed batch with valid privy', async () => {
        const app = createApp([makeProvider('privy', async () => ({ ok: true }))])

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([
                    { jsonrpc: '2.0', id: 1, method: 'wallet_health', params: [] },
                    { jsonrpc: '2.0', id: 2, method: 'wallet_sendPreparedCalls', params: [] },
                ]),
            },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
    })

    it('keeps request body readable for downstream handlers', async () => {
        const app = new Hono<{ Bindings: Env }>()
        app.use(
            '*',
            authMiddleware({ providers: [makeProvider('privy', async () => ({ ok: true }))] }),
        )
        app.post('/', async (c) => {
            const body = await c.req.json()

            return c.json({ ok: true, method: body.method })
        })

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_sendPreparedCalls',
                    params: [],
                }),
            },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, method: 'wallet_sendPreparedCalls' })
    })

    it('returns unauthorized when provider throws and no fallback succeeds', async () => {
        const app = createApp([
            makeProvider('privy', async () => {
                throw new Error('down')
            }),
            makeProvider('erc8128', async () => ({
                ok: false,
                code: 'BAD_SIGNATURE',
                message: 'bad sig',
            })),
        ])

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 3,
                    method: 'wallet_sendPreparedCalls',
                    params: [],
                }),
            },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            jsonrpc: '2.0',
            id: 3,
            error: {
                code: -32001,
                message: 'Unauthorized',
                data: {
                    auth_code: 'PRIVY_API_UNAVAILABLE',
                },
            },
        })
    })

    it('bypasses auth for non-POST and non-root requests', async () => {
        const verify = vi.fn(async () => ({
            ok: false as const,
            code: 'INVALID_TOKEN' as const,
            message: 'x',
        }))

        const app = new Hono<{ Bindings: Env }>()
        app.use('*', authMiddleware({ providers: [makeProvider('privy', verify)] }))
        app.get('/health', (c) => c.json({ status: 'ok' }))

        const response = await app.request(
            'http://localhost/health',
            { method: 'GET' },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ status: 'ok' })
        expect(verify).not.toHaveBeenCalled()
    })

    it('namespaces an OIDC caller on the rate-limit key', async () => {
        const account = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
        const app = new Hono<{ Bindings: Env }>()
        app.use(
            '*',
            authMiddleware({
                providers: [
                    makeProvider('oidc', async () => ({
                        ok: true,
                        userId: 'User_1',
                        issuer: 'https://Issuer.Example',
                    })),
                ],
            }),
        )
        app.post('/', (c) => c.json({ key: upgradeRateIdentity(account) }))

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_sendPreparedCalls',
                    params: [],
                }),
            },
            createEnv(),
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ key: 'oidc:https://issuer.example:user_1' })
    })
})
