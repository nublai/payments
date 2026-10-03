/**
 * Unit tests for calls RPC methods
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RpcContext } from '../../src/rpc/types'
import { handlePrepareCalls } from '../../src/rpc/methods/prepareCalls'
import {
    handleBatchSendPreparedCalls,
    handleSendPreparedCalls,
} from '../../src/rpc/methods/sendPreparedCalls'
import { handleGetCallsStatus } from '../../src/rpc/methods/getCallsStatus'
import { handleGetCallsHistory } from '../../src/rpc/methods/getCallsHistory'
import { RpcError, INVALID_PARAMS, SIMULATION_FAILED } from '../../src/rpc/errors'

// Mock RelayerService
const { mockPrepareIntent, mockSimulateIntent, mockMarkSubmitted, mockCreateIntentNonceProvider } =
    vi.hoisted(() => ({
        mockPrepareIntent: vi.fn(),
        mockSimulateIntent: vi.fn(),
        mockMarkSubmitted: vi.fn(),
        mockCreateIntentNonceProvider: vi.fn().mockReturnValue({
            acquireNonce: vi.fn().mockResolvedValue(1n),
            acquireNonceSynced: vi.fn().mockResolvedValue({ nonce: 1n, synced: false }),
            syncNonce: vi.fn().mockResolvedValue(undefined),
            markSubmitted: vi.fn(),
        }),
    }))

vi.mock('../../src/services/relayer', () => ({
    RelayerService: vi.fn().mockImplementation(() => ({
        prepareIntent: mockPrepareIntent,
        simulateIntent: mockSimulateIntent,
    })),
    createIntentNonceProvider: mockCreateIntentNonceProvider,
    isPaymentEnabled: vi
        .fn()
        .mockImplementation(
            (payer: string, paymentToken: string) =>
                payer !== '0x0000000000000000000000000000000000000000' &&
                paymentToken !== '0x0000000000000000000000000000000000000000',
        ),
}))

// Mock logger
vi.mock('../../src/lib/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
    getErrorMessage: vi.fn((error: unknown) =>
        error instanceof Error ? error.message : String(error),
    ),
}))

vi.mock('../../src/services/price-oracle', () => ({
    getEthUsdPrice: vi.fn().mockResolvedValue(3000n * 10n ** 18n),
    getUsdPrice: vi.fn().mockResolvedValue(1n * 10n ** 18n),
    formatPriceForQuote: vi.fn().mockReturnValue('0x0'),
}))

// Mock config with stable functions (avoid reset by clearAllMocks)
vi.mock('../../src/config', () => ({
    getChainIds: (env: { CHAIN_IDS?: string }) =>
        (env.CHAIN_IDS ?? '')
            .split(',')
            .map((id) => Number.parseInt(id.trim(), 10))
            .filter((id) => Number.isFinite(id)),
    getChainConfig: () => ({
        rpcUrl: 'https://example.com/rpc',
        chainId: 8453,
        contracts: {
            townsAccount: '0x1234567890123456789012345678901234567890',
            accountProxy: '0x2345678901234567890123456789012345678901',
            orchestrator: '0x3456789012345678901234567890123456789012',
            simpleFunder: '0x4567890123456789012345678901234567890123',
            simulator: '0x5678901234567890123456789012345678901234',
        },
    }),
}))

beforeEach(() => {
    vi.clearAllMocks()
    mockCreateIntentNonceProvider.mockReturnValue({
        acquireNonce: vi.fn().mockResolvedValue(1n),
        acquireNonceSynced: vi.fn().mockResolvedValue({ nonce: 1n, synced: false }),
        syncNonce: vi.fn().mockResolvedValue(undefined),
        markSubmitted: mockMarkSubmitted,
    })
    mockMarkSubmitted.mockResolvedValue('cleared')
})

// Create mock context
const createMockCtx = (): RpcContext => ({
    env: {
        RPC_URL: 'https://example.com/rpc',
        RPC_8453: 'https://example.com/rpc',
        CHAIN_IDS: '8453',
        ORCHESTRATOR_8453: '0x3456789012345678901234567890123456789012',
        SIMPLE_FUNDER_8453: '0x4567890123456789012345678901234567890123',
        SIMULATOR_8453: '0x5678901234567890123456789012345678901234',
        TOWNS_ACCOUNT_8453: '0x1234567890123456789012345678901234567890',
        ACCOUNT_PROXY_8453: '0x2345678901234567890123456789012345678901',
        SIMPLE_SETTLER_8453: '0x6789012345678901234567890123456789012345',
        ESCROW_8453: '0x7890123456789012345678901234567890123456',
        MULTI_SIG_SIGNER_8453: '0x8901234567890123456789012345678901234567',
        INTENT_NONCE_MANAGER: {},
        SIGNER_POOL: {
            idFromName: vi.fn().mockReturnValue('pool-id'),
            get: vi.fn().mockReturnValue({
                fetch: vi.fn().mockResolvedValue({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            txHash: '0xabc',
                            signer: '0x123',
                            signerName: 'signer-8453-0',
                        }),
                }),
            }),
        },
    },
})

function buildSendPreparedCallsParams(options?: { withTelemetry?: boolean }) {
    const quote = {
        chainId: '0x2105',
        intent: {
            eoa: '0x1234567890123456789012345678901234567890',
            calls: [
                {
                    to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                    value: '0',
                    data: '0x',
                },
            ],
            nonce: '1',
            combinedGas: '500000',
            expiry: '1700000000',
        },
        orchestrator: '0x3456789012345678901234567890123456789012',
        extraPayment: '0x0',
        ethPrice: '0x0',
        paymentTokenDecimals: 18,
        txGas: 500000,
        nativeFeeEstimate: {
            maxFeePerGas: 1000000000,
            maxPriorityFeePerGas: 100000000,
        },
        feeTokenDeficit: '0x0',
        assetDeficits: [] as unknown[],
        ...(options?.withTelemetry
            ? {
                  telemetry: {
                      paymentEnabled: true,
                      simulationGas: '123456',
                      combinedGas: '234567',
                      txGas: '345678',
                  },
              }
            : {}),
    }

    return {
        context: {
            quote: {
                quotes: [quote],
                signature: '0x',
                ttl: Math.floor(Date.now() / 1000) + 300,
            },
        },
        signature: '0x' + 'ab'.repeat(65),
    }
}

describe('wallet_prepareCalls', () => {
    beforeEach(() => {
        // per-test overrides can go here
    })

    it('should return typedData, digest, context with quote, and capabilities (spec-compliant)', async () => {
        mockPrepareIntent.mockResolvedValue({
            success: true,
            typedData: {
                domain: { name: 'Orchestrator', version: '0.5.5', chainId: 8453 },
                types: {},
                primaryType: 'Intent',
                message: {},
            },
            nonce: '1',
            combinedGas: '500000',
            expiry: '1700000000',
            digest: '0xdigest',
        })

        const ctx = createMockCtx()
        const params = {
            from: '0x1234567890123456789012345678901234567890',
            chain_id: '0x2105',
            calls: [
                {
                    to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                    data: '0x',
                    value: '0x0',
                },
            ],
        }

        const result = await handlePrepareCalls(params, ctx)

        // Spec-compliant response structure
        expect(result).toHaveProperty('digest')
        expect(result).toHaveProperty('typedData')
        expect(result).toHaveProperty('context')
        expect(result).toHaveProperty('capabilities')
        expect(result).toHaveProperty('signature')

        // Context should have quote wrapper
        expect(result.context).toHaveProperty('quote')
        expect(result.context.quote).toHaveProperty('quotes')
        expect(result.context.quote).toHaveProperty('signature')
        expect(result.context.quote).toHaveProperty('ttl')

        // Capabilities should have spec fields
        expect(result.capabilities).toHaveProperty('feeTotals')
        expect(result.capabilities).toHaveProperty('assetDiffs')
    })

    it('should throw error for missing from address', async () => {
        const ctx = createMockCtx()
        const params = {
            chain_id: '0x2105',
            calls: [],
        }

        await expect(handlePrepareCalls(params, ctx)).rejects.toThrow(RpcError)
    })

    it('should throw error for invalid calls', async () => {
        const ctx = createMockCtx()
        const params = {
            from: '0x1234567890123456789012345678901234567890',
            chain_id: '0x2105',
            calls: 'invalid',
        }

        await expect(handlePrepareCalls(params, ctx)).rejects.toThrow(RpcError)
    })

    it('passes expiry override from capabilities.meta to prepareIntent', async () => {
        mockPrepareIntent.mockResolvedValue({
            success: true,
            typedData: {
                domain: { name: 'Orchestrator', version: '0.5.5', chainId: 8453 },
                types: {},
                primaryType: 'Intent',
                message: {},
            },
            nonce: '1',
            combinedGas: '500000',
            expiry: '1700000000',
            digest: '0xdigest',
        })

        const ctx = createMockCtx()
        const params = {
            from: '0x1234567890123456789012345678901234567890',
            chain_id: '0x2105',
            calls: [
                {
                    to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                    data: '0x',
                    value: '0x0',
                },
            ],
            capabilities: {
                meta: {
                    expiry: '1700000123',
                },
            },
        }

        await handlePrepareCalls(params, ctx)

        expect(mockPrepareIntent).toHaveBeenCalledWith(
            expect.objectContaining({
                expiry: '1700000123',
            }),
        )
    })

    it('returns structured simulation error when prepare simulation fails', async () => {
        mockPrepareIntent.mockResolvedValue({
            success: false,
            error: 'Simulation failed: VerificationError',
        })

        const ctx = createMockCtx()
        const params = {
            from: '0x1234567890123456789012345678901234567890',
            chain_id: '0x2105',
            calls: [
                {
                    to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                    data: '0x',
                    value: '0x0',
                },
            ],
        }

        await expect(handlePrepareCalls(params, ctx)).rejects.toMatchObject({
            code: SIMULATION_FAILED,
            message: 'Simulation failed',
            data: { cause: 'VerificationError' },
        } satisfies Partial<RpcError>)
    })
})

describe('wallet_sendPreparedCalls', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should submit intent to signer pool and return bundle id (quote context)', async () => {
        const ctx = createMockCtx()
        const params = buildSendPreparedCallsParams()

        const result = await handleSendPreparedCalls(params, ctx)

        expect(result).toHaveProperty('id')
    })

    it('should reject legacy flat context without quote chain context', async () => {
        const ctx = createMockCtx()
        const params = {
            context: {
                eoa: '0x1234567890123456789012345678901234567890',
                calls: [
                    { to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', value: '0', data: '0x' },
                ],
                nonce: '1',
                combinedGas: '500000',
                expiry: '1700000000',
            },
            signature: '0x' + 'ab'.repeat(65),
        }

        await expect(handleSendPreparedCalls(params, ctx)).rejects.toThrow(
            'Missing chain_id in context',
        )
    })

    it('should throw error for missing context', async () => {
        const ctx = createMockCtx()
        const params = {
            signature: '0x' + 'ab'.repeat(65),
        }

        await expect(handleSendPreparedCalls(params, ctx)).rejects.toThrow(RpcError)
    })

    it('should throw error for missing signature', async () => {
        const ctx = createMockCtx()
        const params = {
            context: {
                quote: {
                    quotes: [],
                    signature: '0x',
                    ttl: 0,
                },
            },
        }

        await expect(handleSendPreparedCalls(params, ctx)).rejects.toThrow(RpcError)
    })

    it('returns success even if draft finalization throws after submission', async () => {
        const ctx = createMockCtx()
        mockMarkSubmitted.mockRejectedValueOnce(new Error('draft finalize failed'))

        const baseParams = buildSendPreparedCallsParams()
        const params = {
            ...baseParams,
            context: {
                ...baseParams.context,
                draft: {
                    id: 'draft-1',
                    seqKey: '0',
                    expiresAtMs: Date.now() + 60_000,
                    fromCache: false,
                },
            },
        }

        const result = await handleSendPreparedCalls(params, ctx)
        expect(result).toHaveProperty('id')
        expect(mockMarkSubmitted).toHaveBeenCalled()
    })

    it('treats settler metadata as inert (does not store pending multichain bundle)', async () => {
        const bundleFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ ok: true }),
        })

        const ctx = createMockCtx()
        ;(ctx.env as Record<string, unknown>).BUNDLE_STATUS_DO = {
            idFromName: vi.fn().mockReturnValue('bundle-status-id'),
            get: vi.fn().mockReturnValue({
                fetch: bundleFetch,
            }),
        }

        const baseParams = buildSendPreparedCallsParams()
        const baseQuote = baseParams.context.quote.quotes[0]
        const params = {
            ...baseParams,
            context: {
                ...baseParams.context,
                quote: {
                    ...baseParams.context.quote,
                    quotes: [
                        {
                            ...baseQuote,
                            intent: {
                                ...baseQuote.intent,
                                settler: '0x1111111111111111111111111111111111111111',
                                settlerContext:
                                    '0x0000000000000000000000000000000000000000000000000000000000000020' +
                                    '0000000000000000000000000000000000000000000000000000000000000001' +
                                    '0000000000000000000000000000000000000000000000000000000000002105',
                            },
                        },
                    ],
                },
            },
        }

        await handleSendPreparedCalls(params, ctx)

        const calledUrls = bundleFetch.mock.calls.map(
            (args) => (args[0] as string | undefined) ?? '',
        )
        expect(calledUrls.some((url) => url.includes('/add_bundle_tx'))).toBe(true)
        expect(calledUrls.some((url) => url.includes('/store_pending_bundle'))).toBe(false)
    })

    it('stores bundle telemetry when quote telemetry is present', async () => {
        const bundleFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ ok: true }),
        })

        const ctx = createMockCtx()
        ;(ctx.env as Record<string, unknown>).BUNDLE_STATUS_DO = {
            idFromName: vi.fn().mockReturnValue('bundle-status-id'),
            get: vi.fn().mockReturnValue({
                fetch: bundleFetch,
            }),
        }

        const params = buildSendPreparedCallsParams({ withTelemetry: true })

        await handleSendPreparedCalls(params, ctx)

        const calledUrls = bundleFetch.mock.calls.map(
            (args) => (args[0] as string | undefined) ?? '',
        )
        expect(calledUrls.some((url) => url.includes('/upsert_bundle_telemetry'))).toBe(true)
    })

    it('normalizes telemetry EOA to lowercase before persisting', async () => {
        const bundleFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ ok: true }),
        })

        const ctx = createMockCtx()
        ;(ctx.env as Record<string, unknown>).BUNDLE_STATUS_DO = {
            idFromName: vi.fn().mockReturnValue('bundle-status-id'),
            get: vi.fn().mockReturnValue({
                fetch: bundleFetch,
            }),
        }

        const mixedCaseEoa = '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD'
        const params = buildSendPreparedCallsParams({ withTelemetry: true })
        params.context.quote.quotes[0].intent.eoa = mixedCaseEoa

        await handleSendPreparedCalls(params, ctx)

        const telemetryCall = bundleFetch.mock.calls.find((args) =>
            String(args[0]).includes('/upsert_bundle_telemetry'),
        )
        expect(telemetryCall).toBeDefined()
        const requestInit = telemetryCall?.[1] as RequestInit
        const payload = JSON.parse(String(requestInit.body)) as { eoa?: string }
        expect(payload.eoa).toBe(mixedCaseEoa.toLowerCase())
    })

    it('succeeds when telemetry persistence fails after bundle mapping succeeds', async () => {
        const bundleFetch = vi.fn(async (url: string) => {
            if (url.includes('/add_bundle_tx')) {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: () => Promise.resolve({ ok: true }),
                }
            }
            if (url.includes('/upsert_bundle_telemetry')) {
                throw new Error('telemetry write failed')
            }
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: () => Promise.resolve({ ok: true }),
            }
        })

        const ctx = createMockCtx()
        ;(ctx.env as Record<string, unknown>).BUNDLE_STATUS_DO = {
            idFromName: vi.fn().mockReturnValue('bundle-status-id'),
            get: vi.fn().mockReturnValue({
                fetch: bundleFetch,
            }),
        }

        const params = buildSendPreparedCallsParams({ withTelemetry: true })

        await expect(handleSendPreparedCalls(params, ctx)).resolves.toHaveProperty('id')
    })

    it('throws when bundle mapping persistence returns non-ok response', async () => {
        const bundleFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        })

        const ctx = createMockCtx()
        ;(ctx.env as Record<string, unknown>).BUNDLE_STATUS_DO = {
            idFromName: vi.fn().mockReturnValue('bundle-status-id'),
            get: vi.fn().mockReturnValue({
                fetch: bundleFetch,
            }),
        }

        const params = buildSendPreparedCallsParams()

        await expect(handleSendPreparedCalls(params, ctx)).rejects.toMatchObject({
            code: -32002,
            message: expect.stringContaining('bundle tracking unavailable'),
        })
    })

    it('returns per-request error when batch bundle mapping persistence fails', async () => {
        const bundleFetch = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })
            .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' })

        const ctx = createMockCtx()
        ;(ctx.env as Record<string, unknown>).BUNDLE_STATUS_DO = {
            idFromName: vi.fn().mockReturnValue('bundle-status-id'),
            get: vi.fn().mockReturnValue({
                fetch: bundleFetch,
            }),
        }

        const sendParams = buildSendPreparedCallsParams()

        const result = await handleBatchSendPreparedCalls(
            [
                { id: 1, params: sendParams },
                { id: 2, params: sendParams },
            ],
            ctx,
        )

        expect(result).toHaveLength(2)
        expect(result[0]).toHaveProperty('error')
        expect(result[1]).toHaveProperty('result')
    })
})

describe('wallet_getCallsHistory', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    function createHistoryCtx(
        chainEntries: Record<
            number,
            Array<{ bundleId: string; chainId: number; createdAt: number }>
        >,
    ): { ctx: RpcContext; chainSpies: Map<number, ReturnType<typeof vi.fn>> } {
        const chainSpies = new Map<number, ReturnType<typeof vi.fn>>()

        const ctx = createMockCtx()
        ;(ctx.env as Record<string, unknown>).CHAIN_IDS = Object.keys(chainEntries).join(',')
        ;(ctx.env as Record<string, unknown>).BUNDLE_STATUS_DO = {
            idFromName: vi.fn((name: string) => name),
            get: vi.fn((name: string) => {
                const chainId = Number(name.replace('bundle-status-', ''))
                const entries = chainEntries[chainId] ?? []
                const getBundlesByEoa = vi.fn(
                    async (_eoa: string, limit: number, offset: number) => ({
                        items: entries.slice(offset, offset + limit),
                        total: entries.length,
                    }),
                )
                chainSpies.set(chainId, getBundlesByEoa)
                return { getBundlesByEoa }
            }),
        }

        return { ctx, chainSpies }
    }

    it('paginates correctly when offset exceeds the first per-chain fetch page', async () => {
        const chainId = 8453
        const entries = Array.from({ length: 30 }, (_, index) => ({
            bundleId: `bundle-${index}`,
            chainId,
            createdAt: 10_000 - index,
        }))
        const { ctx } = createHistoryCtx({ [chainId]: entries })

        const result = await handleGetCallsHistory(
            {
                address: '0x1234567890123456789012345678901234567890',
                limit: 3,
                offset: 25,
            },
            ctx,
        )

        expect(result.total).toBe(30)
        expect(result.items.map((item) => item.id)).toEqual(['bundle-25', 'bundle-26', 'bundle-27'])
    })

    it('rejects requests where offset plus limit exceeds the maximum target size', async () => {
        const { ctx } = createHistoryCtx({ 8453: [] })

        await expect(
            handleGetCallsHistory(
                {
                    address: '0x1234567890123456789012345678901234567890',
                    limit: 100,
                    offset: 901,
                },
                ctx,
            ),
        ).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'offset + limit must be less than or equal to 1000',
        })
    })

    it('normalizes address casing and merges multi-chain results', async () => {
        const { ctx, chainSpies } = createHistoryCtx({
            8453: [
                { bundleId: 'a1', chainId: 8453, createdAt: 300 },
                { bundleId: 'a2', chainId: 8453, createdAt: 200 },
            ],
            10: [
                { bundleId: 'b1', chainId: 10, createdAt: 290 },
                { bundleId: 'b2', chainId: 10, createdAt: 250 },
            ],
        })

        const mixedCaseAddress = '0x1234567890abCDef1234567890AbCdEf12345678'
        const result = await handleGetCallsHistory(
            {
                address: mixedCaseAddress,
                limit: 3,
                offset: 0,
            },
            ctx,
        )

        expect(result.items.map((item) => item.id)).toEqual(['a1', 'b1', 'b2'])
        expect(result.total).toBe(4)
        expect(chainSpies.get(8453)).toHaveBeenCalledWith(mixedCaseAddress.toLowerCase(), 20, 0)
        expect(chainSpies.get(10)).toHaveBeenCalledWith(mixedCaseAddress.toLowerCase(), 20, 0)
    })

    it('deduplicates duplicate chain IDs in request params', async () => {
        const { ctx, chainSpies } = createHistoryCtx({
            8453: [{ bundleId: 'a1', chainId: 8453, createdAt: 300 }],
        })

        const result = await handleGetCallsHistory(
            {
                address: '0x1234567890123456789012345678901234567890',
                chainIds: ['0x2105', '0x2105'],
                limit: 10,
                offset: 0,
            },
            ctx,
        )

        expect(result.total).toBe(1)
        expect(result.items.map((item) => item.id)).toEqual(['a1'])
        expect(chainSpies.get(8453)).toHaveBeenCalledTimes(1)
    })

    it('starts initial per-chain history queries concurrently', async () => {
        let resolveFirstChain = (_value: {
            items: Array<{ bundleId: string; chainId: number; createdAt: number }>
            total: number
        }): void => {
            throw new Error('resolveFirstChain was not initialized')
        }

        const firstChainSpy = vi.fn(
            () =>
                new Promise<{
                    items: Array<{ bundleId: string; chainId: number; createdAt: number }>
                    total: number
                }>((resolve) => {
                    resolveFirstChain = resolve
                }),
        )
        const secondChainSpy = vi.fn().mockResolvedValue({
            items: [{ bundleId: 'b1', chainId: 10, createdAt: 123 }],
            total: 1,
        })

        const ctx = createMockCtx()
        ;(ctx.env as Record<string, unknown>).CHAIN_IDS = '8453,10'
        ;(ctx.env as Record<string, unknown>).BUNDLE_STATUS_DO = {
            idFromName: vi.fn((name: string) => name),
            get: vi.fn((name: string) => {
                if (name === 'bundle-status-8453') {
                    return { getBundlesByEoa: firstChainSpy }
                }
                return { getBundlesByEoa: secondChainSpy }
            }),
        }

        const resultPromise = handleGetCallsHistory(
            {
                address: '0x1234567890123456789012345678901234567890',
                limit: 1,
                offset: 0,
            },
            ctx,
        )

        await Promise.resolve()

        expect(firstChainSpy).toHaveBeenCalledTimes(1)
        expect(secondChainSpy).toHaveBeenCalledTimes(1)

        resolveFirstChain({ items: [], total: 0 })
        const result = await resultPromise

        expect(result.total).toBe(1)
        expect(result.items.map((item) => item.id)).toEqual(['b1'])
    })

    it('continues when a chain fails during follow-up page fetch', async () => {
        const chainAEntries = Array.from({ length: 50 }, (_, index) => ({
            bundleId: `a-${index}`,
            chainId: 8453,
            createdAt: 20_000 - index,
        }))
        const chainBEntries = Array.from({ length: 50 }, (_, index) => ({
            bundleId: `b-${index}`,
            chainId: 10,
            createdAt: 10_000 - index,
        }))

        const chainASpy = vi.fn(async (_eoa: string, limit: number, offset: number) => {
            if (offset > 0) {
                throw new Error('chain A pagination failure')
            }
            return {
                items: chainAEntries.slice(offset, offset + limit),
                total: chainAEntries.length,
            }
        })
        const chainBSpy = vi.fn(async (_eoa: string, limit: number, offset: number) => ({
            items: chainBEntries.slice(offset, offset + limit),
            total: chainBEntries.length,
        }))

        const ctx = createMockCtx()
        ;(ctx.env as Record<string, unknown>).CHAIN_IDS = '8453,10'
        ;(ctx.env as Record<string, unknown>).BUNDLE_STATUS_DO = {
            idFromName: vi.fn((name: string) => name),
            get: vi.fn((name: string) =>
                name === 'bundle-status-8453'
                    ? { getBundlesByEoa: chainASpy }
                    : { getBundlesByEoa: chainBSpy },
            ),
        }

        const result = await handleGetCallsHistory(
            {
                address: '0x1234567890123456789012345678901234567890',
                limit: 5,
                offset: 40,
            },
            ctx,
        )

        expect(chainASpy).toHaveBeenCalledTimes(2)
        expect(chainBSpy).toHaveBeenCalledTimes(2)
        expect(result.items).toHaveLength(5)
        expect(result.total).toBe(chainBEntries.length)
    })
})

describe('wallet_getCallsStatus', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    const createMockCtxWithBundleStatus = (mockResponse: unknown): RpcContext => ({
        env: {
            RPC_URL: 'https://example.com/rpc',
            CHAIN_IDS: '8453',
            INTENT_NONCE_MANAGER: {},
            SIGNER_POOL: {
                idFromName: vi.fn().mockReturnValue('pool-id'),
                get: vi.fn().mockReturnValue({
                    fetch: vi.fn().mockResolvedValue({
                        ok: true,
                        json: () => Promise.resolve({ txHash: '0xabc', signer: '0x123' }),
                    }),
                }),
            },
            BUNDLE_STATUS_DO: {
                idFromName: vi.fn().mockReturnValue('bundle-status-id'),
                get: vi.fn().mockReturnValue({
                    fetch: vi.fn().mockResolvedValue({
                        ok: true,
                        json: () => Promise.resolve(mockResponse),
                    }),
                }),
            },
        },
    })

    it('should return pending status for new bundle', async () => {
        const ctx = createMockCtxWithBundleStatus({
            bundleId: 'bundle-123',
            status: 'pending',
            statusCode: 100,
            receipts: [],
        })
        const result = await handleGetCallsStatus('bundle-123', ctx)

        expect(result).toHaveProperty('id', 'bundle-123')
        expect(result).toHaveProperty('status', 100)
        expect(result).toHaveProperty('receipts')
        expect(result.receipts).toBeInstanceOf(Array)
        expect(result.receipts).toHaveLength(0)
    })

    it('should return confirmed status with receipt', async () => {
        const ctx = createMockCtxWithBundleStatus({
            bundleId: 'bundle-456',
            status: 'confirmed',
            statusCode: 200,
            receipts: [
                {
                    chain_id: '0x2105',
                    transaction_hash: '0xhash',
                    status: true,
                    gas_used: '21000',
                    logs: [],
                },
            ],
        })
        const result = await handleGetCallsStatus('bundle-456', ctx)

        expect(result).toHaveProperty('id', 'bundle-456')
        expect(result).toHaveProperty('status', 200)
        expect(result).toHaveProperty('receipts')
        expect(result.receipts).toBeInstanceOf(Array)
        expect(result.receipts).toHaveLength(1)
        expect(result.receipts[0]).toHaveProperty('status', true)
        expect(result.receipts[0]).toHaveProperty('transaction_hash', '0xhash')
        expect(result.receipts[0]).toHaveProperty('gas_used', '21000')
        expect(result.receipts[0]).toHaveProperty('logs')
        expect(result.receipts[0].logs).toBeInstanceOf(Array)
    })

    it('should return not_found status with empty receipts', async () => {
        const ctx = createMockCtxWithBundleStatus({
            bundleId: 'unknown',
            status: 'not_found',
            statusCode: 404,
            receipts: [],
        })
        const result = await handleGetCallsStatus('unknown', ctx)

        expect(result).toHaveProperty('id', 'unknown')
        expect(result).toHaveProperty('status', 404)
        expect(result).toHaveProperty('receipts')
        expect(result.receipts).toBeInstanceOf(Array)
        expect(result.receipts).toHaveLength(0)
    })

    it('should return failed status with receipt showing reverted', async () => {
        const ctx = createMockCtxWithBundleStatus({
            bundleId: 'bundle-failed',
            status: 'failed',
            statusCode: 400,
            receipts: [
                {
                    chain_id: '0x2105',
                    transaction_hash: '0xfailed',
                    status: false,
                    gas_used: '50000',
                    logs: [],
                },
            ],
        })
        const result = await handleGetCallsStatus('bundle-failed', ctx)

        expect(result).toHaveProperty('id', 'bundle-failed')
        expect(result).toHaveProperty('status', 400)
        expect(result).toHaveProperty('receipts')
        expect(result.receipts).toHaveLength(1)
        expect(result.receipts[0]).toHaveProperty('status', false)
        expect(result.receipts[0]).toHaveProperty('transaction_hash', '0xfailed')
    })

    it('should return 404 when BUNDLE_STATUS_DO is not configured', async () => {
        const ctx = createMockCtx()
        const result = await handleGetCallsStatus('bundle-no-do', ctx)

        expect(result).toHaveProperty('id', 'bundle-no-do')
        expect(result).toHaveProperty('status', 404)
        expect(result).toHaveProperty('receipts')
        expect(result.receipts).toHaveLength(0)
    })
})
