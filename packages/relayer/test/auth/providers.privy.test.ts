import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Address } from 'viem'
import type { Env } from '../../src/types/env'
import { authorizeRequest } from '../../src/auth/engine'
import { authIdentityOwnsAccount, runWithAuthIdentity } from '../../src/auth/identity'

const privyClientMock = vi.hoisted(() => vi.fn())

const verifyAuthTokenMock = vi.hoisted(() => vi.fn())

const getUserByWalletAddressMock = vi.hoisted(() => vi.fn())

vi.mock('@privy-io/server-auth', () => ({
    PrivyClient: privyClientMock.mockImplementation(() => ({
        verifyAuthToken: verifyAuthTokenMock,
        getUserByWalletAddress: getUserByWalletAddressMock,
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
        getUserByWalletAddressMock.mockReset()
    })

    it('is enabled only when PRIVY_ENABLED=true', () => {
        const provider = createPrivyProvider()
        expect(provider.enabled({ PRIVY_ENABLED: 'true' } as Env)).toBe(true)
        expect(provider.enabled({ PRIVY_ENABLED: 'false' } as Env)).toBe(false)
    })

    it('stays enabled when PRIVY_ENABLED is unset', () => {
        const provider = createPrivyProvider()
        expect(provider.enabled({} as Env)).toBe(true)
        expect(provider.enabled({ PRIVY_ENABLED: '' } as Env)).toBe(true)
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

    it('rejects an upgrade when the Privy user is not linked to the account', async () => {
        verifyAuthTokenMock.mockResolvedValueOnce({
            appId: 'app_123',
            userId: 'did:privy:user_1',
        })
        getUserByWalletAddressMock.mockResolvedValueOnce(null)

        const provider = createPrivyProvider()

        const result = await provider.verify(
            new Request('https://relayer.example.com/', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_upgradeAccount',
                    params: [
                        {
                            context: {
                                address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
                            },
                        },
                    ],
                }),
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        expect(result).toEqual({
            ok: false,
            code: 'NO_LINKED_WALLET',
            message: 'Privy user is not bound to the account',
        })
    })

    it('binds a Privy upgrade to the linked wallet', async () => {
        verifyAuthTokenMock.mockResolvedValueOnce({
            appId: 'app_123',
            userId: 'did:privy:user_1',
        })
        getUserByWalletAddressMock.mockResolvedValueOnce({
            id: 'did:privy:user_1',
            linkedAccounts: [
                { type: 'wallet', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
            ],
        })

        const provider = createPrivyProvider()

        const result = await provider.verify(
            new Request('https://relayer.example.com/', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer token_1',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_upgradeAccount',
                    params: [
                        {
                            context: {
                                address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
                            },
                        },
                    ],
                }),
            }),
            {
                env: makeEnv(),
                nowSeconds: 1_700_000_000,
            },
        )

        expect(result).toEqual({
            ok: true,
            userId: 'did:privy:user_1',
            boundAccounts: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
        })
    })

    it('rejects an upgrade when the linked wallet does not checksum-match the account', async () => {
        verifyAuthTokenMock.mockResolvedValueOnce({
            appId: 'app_123',
            userId: 'did:privy:user_1',
        })
        getUserByWalletAddressMock.mockResolvedValueOnce({
            id: 'did:privy:user_1',
            linkedAccounts: [
                { type: 'wallet', address: '0x00000000000000000000000000000000000000aa' },
            ],
        })

        const provider = createPrivyProvider()

        const result = await authorizeRequest({
            request: upgradeRequest('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'),
            env: makeEnv(),
            nowSeconds: 1_700_000_000,
            providers: [provider],
        })

        expect(result).toEqual({
            ok: false,
            code: 'NO_LINKED_WALLET',
            message: 'Privy user is not bound to the account',
        })
    })

    it('accepts an upgrade when the linked wallet checksum-matches the account', async () => {
        const account = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
        verifyAuthTokenMock.mockResolvedValueOnce({
            appId: 'app_123',
            userId: 'did:privy:user_1',
        })
        getUserByWalletAddressMock.mockResolvedValueOnce({
            id: 'did:privy:user_1',
            linkedAccounts: [{ type: 'wallet', address: account.toLowerCase() }],
        })

        const result = await authorizeRequest({
            request: upgradeRequest(account),
            env: makeEnv(),
            nowSeconds: 1_700_000_000,
            providers: [createPrivyProvider()],
        })

        expect(result.ok).toBe(true)

        if (!result.ok) return
        expect(result.boundAccounts).toEqual([account])

        const owns = runWithAuthIdentity(
            {
                provider: result.provider ?? 'privy',
                userId: String(result.userId),
                boundAccounts: result.boundAccounts,
            },
            () => authIdentityOwnsAccount(account),
        )

        expect(owns).toBe(true)
    })

    it('rejects an upgrade when the only linked account is a smart wallet', async () => {
        const account = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
        verifyAuthTokenMock.mockResolvedValueOnce({
            appId: 'app_123',
            userId: 'did:privy:user_1',
        })
        getUserByWalletAddressMock.mockResolvedValueOnce({
            id: 'did:privy:user_1',
            linkedAccounts: [{ type: 'smart_wallet', address: account }],
        })

        const result = await authorizeRequest({
            request: upgradeRequest(account),
            env: makeEnv(),
            nowSeconds: 1_700_000_000,
            providers: [createPrivyProvider()],
        })

        expect(result).toEqual({
            ok: false,
            code: 'NO_LINKED_WALLET',
            message: 'Privy user is not bound to the account',
        })
    })
})

function upgradeRequest(account: string): Request {
    return new Request('https://relayer.example.com/', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer token_1',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'wallet_upgradeAccount',
            params: [{ context: { address: account } }],
        }),
    })
}
