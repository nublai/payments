import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Env } from '../../src/types/env'

const privyClientMock = vi.hoisted(() => vi.fn())
const verifyAuthTokenMock = vi.hoisted(() => vi.fn())

vi.mock('@privy-io/server-auth', () => ({
    PrivyClient: privyClientMock.mockImplementation(() => ({
        verifyAuthToken: verifyAuthTokenMock,
    })),
}))

import { createPrivyProvider } from '../../src/auth/providers/privy'

function makeEnv(): Env {
    return {
        PRIVY_ENABLED: 'true',
        PRIVY_APP_ID: 'app_123',
        PRIVY_APP_SECRET: 'secret_123',
    } as unknown as Env
}

describe('privy auth provider', () => {
    beforeEach(() => {
        privyClientMock.mockClear()
        verifyAuthTokenMock.mockReset()
    })

    it('is enabled only when PRIVY_ENABLED=true', () => {
        const provider = createPrivyProvider()
        expect(provider.enabled({ PRIVY_ENABLED: 'true' } as Env)).toBe(true)
        expect(provider.enabled({ PRIVY_ENABLED: 'false' } as Env)).toBe(false)
    })

    it('returns INVALID_TOKEN when Authorization header is missing', async () => {
        const provider = createPrivyProvider()
        const result = await provider.verify(new Request('https://relayer.example.com/'), {
            env: makeEnv(),
            nowSeconds: 1_700_000_000,
        })

        expect(result).toEqual({
            ok: false,
            code: 'INVALID_TOKEN',
            message: 'Missing Authorization header',
        })
    })

    it('returns INVALID_TOKEN for bad Authorization scheme', async () => {
        const provider = createPrivyProvider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', {
                headers: { Authorization: 'Basic abc' },
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        expect(result).toEqual({
            ok: false,
            code: 'INVALID_TOKEN',
            message: 'Invalid Authorization header format',
        })
    })

    it('returns INVALID_TOKEN for empty bearer token', async () => {
        const provider = createPrivyProvider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', {
                headers: { Authorization: 'Bearer   ' },
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        expect(result).toEqual({
            ok: false,
            code: 'INVALID_TOKEN',
            message: 'Invalid Authorization header format',
        })
    })

    it('returns INVALID_TOKEN when token appId does not match configured app', async () => {
        verifyAuthTokenMock.mockResolvedValueOnce({
            appId: 'other_app',
            userId: 'did:privy:user_1',
        })

        const provider = createPrivyProvider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', {
                headers: { Authorization: 'Bearer token_1' },
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        expect(result).toEqual({
            ok: false,
            code: 'INVALID_TOKEN',
            message: 'Token appId mismatch',
        })
    })

    it('returns EXPIRED_TOKEN when SDK throws an expiration-style error', async () => {
        verifyAuthTokenMock.mockRejectedValueOnce(new Error('jwt expired'))

        const provider = createPrivyProvider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', {
                headers: { Authorization: 'Bearer token_1' },
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        expect(result).toEqual({
            ok: false,
            code: 'EXPIRED_TOKEN',
            message: 'Token has expired',
        })
    })

    it('returns PRIVY_API_UNAVAILABLE for upstream/network style failures', async () => {
        verifyAuthTokenMock.mockRejectedValueOnce(new Error('fetch failed'))

        const provider = createPrivyProvider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', {
                headers: { Authorization: 'Bearer token_1' },
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        expect(result).toEqual({
            ok: false,
            code: 'PRIVY_API_UNAVAILABLE',
            message: 'Privy API unavailable',
        })
    })

    it('returns INVALID_TOKEN for non-specific verification errors', async () => {
        verifyAuthTokenMock.mockRejectedValueOnce(new Error('invalid signature'))

        const provider = createPrivyProvider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', {
                headers: { Authorization: 'Bearer token_1' },
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        expect(result).toEqual({
            ok: false,
            code: 'INVALID_TOKEN',
            message: 'Invalid or expired token',
        })
    })

    it('returns success when token is valid and appId matches', async () => {
        verifyAuthTokenMock.mockResolvedValueOnce({
            appId: 'app_123',
            userId: 'did:privy:user_1',
        })

        const provider = createPrivyProvider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', {
                headers: { Authorization: 'Bearer token_1' },
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        expect(result).toEqual({ ok: true, userId: 'did:privy:user_1' })
    })

    it('reuses one PrivyClient instance across verify calls for the same provider', async () => {
        verifyAuthTokenMock.mockResolvedValue({
            appId: 'app_123',
            userId: 'did:privy:user_1',
        })

        const provider = createPrivyProvider()

        const first = await provider.verify(
            new Request('https://relayer.example.com/', {
                headers: { Authorization: 'Bearer token_1' },
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        const second = await provider.verify(
            new Request('https://relayer.example.com/', {
                headers: { Authorization: 'Bearer token_2' },
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_001,
            },
        )

        expect(first).toEqual({ ok: true, userId: 'did:privy:user_1' })
        expect(second).toEqual({ ok: true, userId: 'did:privy:user_1' })
        expect(privyClientMock).toHaveBeenCalledTimes(1)
        expect(verifyAuthTokenMock).toHaveBeenCalledTimes(2)
        expect(verifyAuthTokenMock).toHaveBeenNthCalledWith(1, 'token_1')
        expect(verifyAuthTokenMock).toHaveBeenNthCalledWith(2, 'token_2')
    })
})
