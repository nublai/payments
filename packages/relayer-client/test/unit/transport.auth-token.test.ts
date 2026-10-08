import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const signRequestMock = vi.hoisted(() => vi.fn())

vi.mock('@slicekit/erc8128', () => ({
    signRequest: signRequestMock,
}))

import { createJsonRpcTransport, JsonRpcClientError } from '../../src/transport'

function successResponse(id: number, result: unknown = 'ok') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })
}

describe('createJsonRpcTransport bearer auth', () => {
    beforeEach(() => {
        signRequestMock.mockReset()
        signRequestMock.mockImplementation(async (request: Request) => request)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('adds Authorization header when authToken is configured', async () => {
        let seenAuth: string | null = null

        vi.stubGlobal(
            'fetch',
            vi.fn(async (request: Request | URL | string) => {
                expect(request).toBeInstanceOf(Request)
                seenAuth = (request as Request).headers.get('Authorization')

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
                seenAuth.push((request as Request).headers.get('Authorization'))

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
                seenAuth.push((request as Request).headers.get('Authorization'))

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
        signRequestMock.mockImplementation(async (request: Request) => {
            expect(request.headers.get('Authorization')).toBe('Bearer token_signed')

            return request
        })

        let seenAuth: string | null = null

        vi.stubGlobal(
            'fetch',
            vi.fn(async (request: Request | URL | string) => {
                seenAuth = (request as Request).headers.get('Authorization')

                return successResponse(1)
            }),
        )

        const transport = createJsonRpcTransport('https://relayer.test', {
            httpAuth: {
                authToken: 'token_signed',
                signer: {
                    chainId: 8453,
                    address: '0x1111111111111111111111111111111111111111',
                    signMessage: async () => '0x',
                },
            },
        })

        await transport.request('wallet_health')

        expect(signRequestMock).toHaveBeenCalledTimes(1)
        expect(seenAuth).toBe('Bearer token_signed')
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
