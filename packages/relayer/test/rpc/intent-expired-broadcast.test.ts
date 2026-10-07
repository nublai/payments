/**
 * A post-broadcast failure whose text contains "Intent expired" is not a
 * pre-send expiry. These assertions fail on 697dcf7, which promotes that
 * substring to INTENT_EXPIRED (-32008).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RpcContext } from '../../src/rpc/types'
import { INTENT_EXPIRED, RpcError, SERVICE_UNAVAILABLE } from '../../src/rpc/errors'
import {
    handleBatchSendPreparedCalls,
    handleSendPreparedCalls,
} from '../../src/rpc/methods/sendPreparedCalls'

vi.mock('../../src/services/relayer', () => ({
    RelayerService: vi.fn().mockImplementation(() => ({
        prepareIntent: vi.fn(),
        simulateIntent: vi.fn(),
        getBundleStatus: vi.fn(),
    })),
    createIntentNonceProvider: vi.fn().mockReturnValue({
        acquireNonce: vi.fn().mockResolvedValue(1n),
        syncNonce: vi.fn().mockResolvedValue(undefined),
    }),
}))

vi.mock('../../src/lib/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}))

vi.mock('../../src/config', () => ({
    getChainIds: () => [8453],
    getChainConfig: () => ({
        rpcUrl: 'https://example.com/rpc',
        chainId: 8453,
        contracts: {
            account: '0x1234567890123456789012345678901234567890',
            accountProxy: '0x2345678901234567890123456789012345678901',
            orchestrator: '0x3456789012345678901234567890123456789012',
            simpleFunder: '0x4567890123456789012345678901234567890123',
            simulator: '0x5678901234567890123456789012345678901234',
        },
    }),
}))

const createMockCtx = (body: unknown): RpcContext => {
    return {
        env: {
            RPC_URL: 'https://example.com/rpc',
            RPC_8453: 'https://example.com/rpc',
            CHAIN_IDS: '8453',
            CONTEXT: 'local',
            ORCHESTRATOR_8453: '0x3456789012345678901234567890123456789012',
            SIMPLE_FUNDER_8453: '0x4567890123456789012345678901234567890123',
            SIMULATOR_8453: '0x5678901234567890123456789012345678901234',
            ACCOUNT_8453: '0x1234567890123456789012345678901234567890',
            ACCOUNT_PROXY_8453: '0x2345678901234567890123456789012345678901',
            SIMPLE_SETTLER_8453: '0x6789012345678901234567890123456789012345',
            ESCROW_8453: '0x7890123456789012345678901234567890123456',
            MULTI_SIG_SIGNER_8453: '0x8901234567890123456789012345678901234567',
            INTENT_NONCE_MANAGER: {},
            SIGNER_POOL: {
                idFromName: vi.fn().mockReturnValue('pool-id'),
                get: vi.fn().mockReturnValue({
                    fetch: vi.fn().mockResolvedValue({
                        ok: false,
                        json: () => Promise.resolve(body),
                    }),
                }),
            },
        },
    }
}

const createParams = () => ({
    context: {
        quote: {
            quotes: [
                {
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
                        expiry: String(Math.floor(Date.now() / 1000) + 3600),
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
                    assetDeficits: [],
                },
            ],
            signature: '0x',
            ttl: Math.floor(Date.now() / 1000) + 300,
        },
    },
    signature: '0x' + 'ab'.repeat(65),
})

const broadcastIntentExpired = {
    error: 'Failed to broadcast transaction: Intent expired. Expiry: 1, Current: 2',
    code: 'BROADCAST_FAILED',
    broadcastAttempted: true,
}

describe('post-broadcast Intent expired text', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('classifies a broadcast failure as service unavailable, not intent expiry', async () => {
        const ctx = createMockCtx(broadcastIntentExpired)
        await expect(handleSendPreparedCalls(createParams(), ctx)).rejects.toMatchObject({
            code: SERVICE_UNAVAILABLE,
        })
        await expect(handleSendPreparedCalls(createParams(), ctx)).rejects.toBeInstanceOf(RpcError)
        try {
            await handleSendPreparedCalls(createParams(), ctx)
        } catch (error) {
            expect((error as RpcError).code).toBe(SERVICE_UNAVAILABLE)
            expect((error as RpcError).code).not.toBe(INTENT_EXPIRED)
        }
    })

    it('does not treat INTENT_EXPIRED as pre-send once broadcast was attempted', async () => {
        const ctx = createMockCtx({
            error: 'Failed to broadcast transaction: Intent expired. Expiry: 1, Current: 2',
            code: 'INTENT_EXPIRED',
            broadcastAttempted: true,
        })
        await expect(handleSendPreparedCalls(createParams(), ctx)).rejects.toMatchObject({
            code: SERVICE_UNAVAILABLE,
        })
    })

    it('classifies the same broadcast failure in a batch as service unavailable', async () => {
        const ctx = createMockCtx(broadcastIntentExpired)
        const results = await handleBatchSendPreparedCalls(
            [{ id: 1, params: createParams() }],
            ctx,
        )
        expect(results).toHaveLength(1)
        const error = results[0]?.error
        expect(error).toBeInstanceOf(RpcError)
        const rpcError = error as RpcError
        expect(rpcError.code).toBe(SERVICE_UNAVAILABLE)
        expect(rpcError.code).not.toBe(INTENT_EXPIRED)
    })

    it('still maps a pre-send INTENT_EXPIRED code to intent expiry', async () => {
        const ctx = createMockCtx({
            error: 'Intent expired. Expiry: 1700000000, Current: 1737820000',
            code: 'INTENT_EXPIRED',
            broadcastAttempted: false,
        })
        await expect(handleSendPreparedCalls(createParams(), ctx)).rejects.toMatchObject({
            code: INTENT_EXPIRED,
        })
    })
})
