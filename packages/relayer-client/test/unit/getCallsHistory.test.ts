import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayerPublicClient } from '../../src/types.js'
import { getCallsHistory } from '../../src/actions/getCallsHistory.js'

type HistoryRpcParams = {
    address?: string
    chainIds?: string[]
    limit?: number
    offset?: number
}

type HistoryRpcPayload = {
    params?: HistoryRpcParams[]
}

type CapturedRequest = { payload: HistoryRpcPayload | null }

function parseHistoryRpcPayload(text: string): HistoryRpcPayload {
    return JSON.parse(text)
}

function createClient(): RelayerPublicClient {
    // SAFETY: getCallsHistory only reads relayerConfig (and optional chain.id) to build the JSON-RPC transport; this stub supplies those fields.

    return {
        relayerConfig: {
            relayerUrl: 'https://relayer.test',
            chainId: 8453,
        },
        chain: {
            id: 8453,
        },
    } as RelayerPublicClient
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('getCallsHistory action', () => {
    it('does not scope chainIds when caller omits chainId', async () => {
        const captured: CapturedRequest = { payload: null }

        vi.stubGlobal(
            'fetch',
            vi.fn(async (request: Request | URL | string) => {
                if (request instanceof Request) {
                    captured.payload = parseHistoryRpcPayload(await request.clone().text())
                }

                return new Response(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        result: { items: [], total: 0 },
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
            }),
        )

        const result = await getCallsHistory(createClient(), {
            address: '0x1234567890123456789012345678901234567890',
        })

        expect(result.success).toBe(true)
        const rpcParams = captured.payload?.params?.[0] ?? {}
        expect(rpcParams).toEqual({ address: '0x1234567890123456789012345678901234567890' })
        expect(rpcParams.chainIds).toBeUndefined()
    })

    it('encodes each explicit chainId when caller sets multiple chainIds', async () => {
        const captured: CapturedRequest = { payload: null }

        vi.stubGlobal(
            'fetch',
            vi.fn(async (request: Request | URL | string) => {
                if (request instanceof Request) {
                    captured.payload = parseHistoryRpcPayload(await request.clone().text())
                }

                return new Response(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        result: {
                            items: [{ id: 'bundle-1', chain_id: '0xa', created_at: 123 }],
                            total: 1,
                        },
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
            }),
        )

        const result = await getCallsHistory(createClient(), {
            address: '0x1234567890123456789012345678901234567890',
            chainIds: [10],
            limit: 5,
            offset: 1,
        })

        expect(result.success).toBe(true)

        if (!result.success) {
            throw new Error('expected success response')
        }

        expect(result.items).toEqual([{ id: 'bundle-1', chainId: 10, createdAt: 123 }])
        const rpcParams = captured.payload?.params?.[0] ?? {}
        expect(rpcParams).toEqual({
            address: '0x1234567890123456789012345678901234567890',
            chainIds: ['0xa'],
            limit: 5,
            offset: 1,
        })
    })

    it('scopes chainIds when caller explicitly sets chainIds', async () => {
        const captured: CapturedRequest = { payload: null }

        vi.stubGlobal(
            'fetch',
            vi.fn(async (request: Request | URL | string) => {
                if (request instanceof Request) {
                    captured.payload = parseHistoryRpcPayload(await request.clone().text())
                }

                return new Response(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        result: {
                            items: [],
                            total: 0,
                        },
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                )
            }),
        )

        const result = await getCallsHistory(createClient(), {
            address: '0x1234567890123456789012345678901234567890',
            chainIds: [10, 8453],
        })

        expect(result.success).toBe(true)
        const rpcParams = captured.payload?.params?.[0] ?? {}
        expect(rpcParams).toEqual({
            address: '0x1234567890123456789012345678901234567890',
            chainIds: ['0xa', '0x2105'],
        })
    })
})
