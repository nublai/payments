import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'

import type {Env} from '../../src/types/env'
import { erc8128AuthMiddleware, extractAuthRequirement } from '../../src/auth/erc8128/middleware'
import type { Erc8128VerifyFailureCode } from '../../src/auth/erc8128/verify'
import { unusedBinding, testEnv } from '../helpers/env'
import { addr } from '../helpers/hex'

function createEnv(overrides: Partial<Env> = {}): Env {
    return testEnv({
        CHAIN_IDS: '8453',
        HTTP_AUTH_NONCE_MANAGER: unusedBinding<Env['HTTP_AUTH_NONCE_MANAGER']>(),
        ...overrides,
    })
}

function createApp(verifyResult: { ok: boolean; code?: Erc8128VerifyFailureCode }) {
    const verify = vi.fn(async () => {
        if (verifyResult.ok) {
            return {
                ok: true as const,
                keyId: {
                    raw: 'erc8128:8453:0x1111111111111111111111111111111111111111',
                    namespace: 'erc8128' as const,
                    chainId: 8453,
                    address: addr('0x1111111111111111111111111111111111111111') },
                signerType: 'EOA' as const,
                nonceKey: 'k' }
        }

        return {
            ok: false as const,
            code: verifyResult.code ?? 'BAD_SIGNATURE',
            message: 'fail' }
    })

    const app = new Hono<{ Bindings: Env }>()
    app.use(
        '*',
        erc8128AuthMiddleware({
            verify,
            createNonceStore: () => ({ consumeNonce: async () => true }) }),
    )
    app.post('/', (c) => c.json({ ok: true }))

    return { app, verify }
}

function createAppWithBodyParsing(verifyResult: { ok: boolean; code?: Erc8128VerifyFailureCode }) {
    const verify = vi.fn(async () => {
        if (verifyResult.ok) {
            return {
                ok: true as const,
                keyId: {
                    raw: 'erc8128:8453:0x1111111111111111111111111111111111111111',
                    namespace: 'erc8128' as const,
                    chainId: 8453,
                    address: addr('0x1111111111111111111111111111111111111111') },
                signerType: 'EOA' as const,
                nonceKey: 'k' }
        }

        return {
            ok: false as const,
            code: verifyResult.code ?? 'BAD_SIGNATURE',
            message: 'fail' }
    })

    const app = new Hono<{ Bindings: Env }>()
    app.use(
        '*',
        erc8128AuthMiddleware({
            verify,
            createNonceStore: () => ({ consumeNonce: async () => true }) }),
    )
    app.post('/', async (c) => {
        const body = await c.req.json()

        return c.json({ ok: true, method: body.method })
    })

    return { app, verify }
}

describe('erc8128 middleware helpers', () => {
    it('requires auth when protected method appears in single request', () => {
        const result = extractAuthRequirement(
            { jsonrpc: '2.0', id: 1, method: 'wallet_sendPreparedCalls', params: [] },
            new Set(['wallet_sendPreparedCalls']),
        )

        expect(result).toEqual({ requiresAuth: true, id: 1 })
    })

    it('requires auth when protected method appears in batch request', () => {
        const result = extractAuthRequirement(
            [
                { jsonrpc: '2.0', id: 1, method: 'wallet_health', params: [] },
                { jsonrpc: '2.0', id: 2, method: 'wallet_sendPreparedCalls', params: [] },
            ],
            new Set(['wallet_sendPreparedCalls']),
        )

        expect(result).toEqual({ requiresAuth: true, id: null })
    })
})

describe('erc8128 middleware behavior', () => {
    it('allows unprotected method unsigned when feature enabled', async () => {
        const env = createEnv({ ERC8128_ENABLED: 'true' })
        const { app, verify } = createApp({ ok: false, code: 'BAD_SIGNATURE' })

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_health',
                    params: [] }) },
            env,
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(verify).not.toHaveBeenCalled()
    })

    it('rejects protected method when verification fails', async () => {
        const env = createEnv({ ERC8128_ENABLED: 'true' })
        const { app } = createApp({ ok: false, code: 'BAD_SIGNATURE' })

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'abc',
                    method: 'wallet_sendPreparedCalls',
                    params: [{}] }) },
            env,
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            jsonrpc: '2.0',
            id: 'abc',
            error: {
                code: -32001,
                message: 'Unauthorized',
                data: { auth_code: 'BAD_SIGNATURE' } } })
    })

    it('allows protected method when verification succeeds', async () => {
        const env = createEnv({ ERC8128_ENABLED: 'true' })
        const { app } = createApp({ ok: true })

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 9,
                    method: 'wallet_sendPreparedCalls',
                    params: [{}] }) },
            env,
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
    })

    it('keeps request body readable for downstream handler after auth verification', async () => {
        const env = createEnv({ ERC8128_ENABLED: 'true' })
        const { app } = createAppWithBodyParsing({ ok: true })

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 9,
                    method: 'wallet_sendPreparedCalls',
                    params: [{}] }) },
            env,
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, method: 'wallet_sendPreparedCalls' })
    })

    it('rejects mixed batch when any protected method exists and verification fails', async () => {
        const env = createEnv({ ERC8128_ENABLED: 'true' })
        const { app } = createApp({ ok: false, code: 'REPLAYED_NONCE' })

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([
                    { jsonrpc: '2.0', id: 1, method: 'wallet_health', params: [] },
                    { jsonrpc: '2.0', id: 2, method: 'wallet_sendPreparedCalls', params: [{}] },
                ]) },
            env,
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            jsonrpc: '2.0',
            id: null,
            error: {
                code: -32001,
                message: 'Unauthorized',
                data: { auth_code: 'REPLAYED_NONCE' } } })
    })

    it('returns unauthorized response when verifier throws unexpectedly', async () => {
        const env = createEnv({ ERC8128_ENABLED: 'true' })
        const app = new Hono<{ Bindings: Env }>()
        app.use(
            '*',
            erc8128AuthMiddleware({
                verify: vi.fn(async () => {
                    throw new Error('rpc timeout')
                }),
                createNonceStore: () => ({ consumeNonce: async () => true }) }),
        )
        app.post('/', (c) => c.json({ ok: true }))

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 7,
                    method: 'wallet_sendPreparedCalls',
                    params: [{}] }) },
            env,
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            jsonrpc: '2.0',
            id: 7,
            error: {
                code: -32001,
                message: 'Unauthorized',
                data: { auth_code: 'BAD_SIGNATURE' } } })
    })

    it('does nothing when feature disabled', async () => {
        const env = createEnv({ ERC8128_ENABLED: 'false' })
        const { app, verify } = createApp({ ok: false, code: 'BAD_SIGNATURE' })

        const response = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_sendPreparedCalls',
                    params: [{}] }) },
            env,
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(verify).not.toHaveBeenCalled()
    })
})
