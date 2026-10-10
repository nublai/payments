import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { toHex } from 'viem'

import { createJsonRpcTransport, JsonRpcClientError } from '../../src/transport'

const signerAccount = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

function successResponse(id: number, result: string = 'ok') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })
}

function fetchRequest(input: Request | URL | string): Request {
    if (input instanceof Request) return input

    throw new Error('expected fetch to receive a Request')
}

describe('createJsonRpcTransport bearer auth', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('adds Authorization header when authToken is configured', async () => {
        let seenAuth: string | null = null

        vi.stubGlobal(
            'fetch',
            vi.fn(async (request: Request | URL | string) => {
                expect(request).toBeInstanceOf(Request)
                seenAuth = fetchRequest(request).headers.get('Authorization')

                return successResponse(1)
            }),
        )

        const transport = createJsonRpcTransport('https://relayer.test', {
            httpAuth: {
                authToken: 'token_static',
            },
        })

        await transport.request('wallet_health')

        expect(seenAuth).toBe('Bearer token_static')
    })

    it('uses authTokenProvider per request', async () => {
        const authTokenProvider = vi
            .fn<() => Promise<string | null>>()
            .mockResolvedValueOnce('token_1')
            .mockResolvedValueOnce('token_2')

        const seenAuth: Array<string | null> = []

        vi.stubGlobal(
            'fetch',
            vi.fn(async (request: Request | URL | string) => {
                seenAuth.push(fetchRequest(request).headers.get('Authorization'))

                return successResponse(seenAuth.length)
            }),
        )

        const transport = createJsonRpcTransport('https://relayer.test', {
            httpAuth: {
                authTokenProvider,
            },
        })

        await transport.request('wallet_health')
        await transport.request('wallet_health')

        expect(authTokenProvider).toHaveBeenCalledTimes(2)
        expect(seenAuth).toEqual(['Bearer token_1', 'Bearer token_2'])
    })

    it('omits Authorization header when provider returns null or whitespace', async () => {
        const authTokenProvider = vi
            .fn<() => Promise<string | null>>()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('   ')

        const seenAuth: Array<string | null> = []

        vi.stubGlobal(
            'fetch',
            vi.fn(async (request: Request | URL | string) => {
                seenAuth.push(fetchRequest(request).headers.get('Authorization'))

                return successResponse(seenAuth.length)
            }),
        )

        const transport = createJsonRpcTransport('https://relayer.test', {
            httpAuth: {
                authTokenProvider,
            },
        })

        await transport.request('wallet_health')
        await transport.request('wallet_health')

        expect(seenAuth).toEqual([null, null])
    })

    it('throws typed client error and skips fetch when authTokenProvider throws', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        const transport = createJsonRpcTransport('https://relayer.test', {
            httpAuth: {
                authTokenProvider: vi.fn(async () => {
                    throw new Error('token unavailable')
                }),
            },
        })

        await expect(transport.request('wallet_health')).rejects.toMatchObject({
            code: -32000,
            message: 'Failed to resolve auth token',
        })

        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('keeps bearer header when httpAuth signing is also configured', async () => {
        let seen: Request | undefined

        vi.stubGlobal(
            'fetch',
            vi.fn(async (request: Request | URL | string) => {
                seen = fetchRequest(request)

                return successResponse(1)
            }),
        )

        const transport = createJsonRpcTransport('https://relayer.test', {
            httpAuth: {
                authToken: 'token_signed',
                signer: {
                    chainId: 8453,
                    address: signerAccount.address,
                    signMessage: async (message) =>
                        signerAccount.signMessage({ message: { raw: toHex(message) } }),
                },
            },
        })

        await transport.request('wallet_health')

        expect(seen?.headers.get('Authorization')).toBe('Bearer token_signed')
        expect(seen?.headers.get('Signature')).toBeTruthy()
        expect(seen?.headers.get('Signature-Input')).toBeTruthy()
    })

    it('surfaces token-provider failure as JsonRpcClientError', async () => {
        const transport = createJsonRpcTransport('https://relayer.test', {
            httpAuth: {
                authTokenProvider: vi.fn(async () => {
                    throw new Error('boom')
                }),
            },
        })

        await expect(transport.request('wallet_health')).rejects.toBeInstanceOf(JsonRpcClientError)
    })
})
