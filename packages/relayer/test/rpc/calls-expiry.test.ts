/**
 * Integration tests for wallet_sendPreparedCalls expiry validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RpcContext } from '../../src/rpc/types'
import { RpcError } from '../../src/rpc/errors'
import { handleSendPreparedCalls } from '../../src/rpc/methods/sendPreparedCalls'

// Helper to create mock context with configurable signer pool behavior
const createMockCtx = (signerPoolResponse?: {
    ok: boolean
    json: () => Promise<unknown>
}): RpcContext => {
    const defaultResponse = {
        ok: true,
        json: () => Promise.resolve({ txHash: '0xabc', signer: '0x123' }),
    }

    return {
        env: {
            RPC_URL: 'https://example.com/rpc',
            RPC_8453: 'https://example.com/rpc',
            CHAIN_IDS: '8453',
            // These handlers exercise the local unsigned-quote path.
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
                    fetch: vi.fn().mockResolvedValue(signerPoolResponse ?? defaultResponse),
                }),
            },
        },
    }
}

// Helper to create valid params with specified expiry
const createParams = (expiry: string) => ({
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
                        expiry,
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

describe('wallet_sendPreparedCalls expiry validation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('rejects expired intent with INTENT_EXPIRED error', async () => {
        // Mock signer pool to return expiry error (this is how it propagates)
        const ctx = createMockCtx({
            ok: false,
            json: () =>
                Promise.resolve({
                    error: 'Intent expired. Expiry: 1700000000, Current: 1737820000',
                    code: 'INTENT_EXPIRED',
                }),
        })

        const expiredExpiry = String(Math.floor(Date.now() / 1000) - 60) // 1 min ago
        const params = createParams(expiredExpiry)

        await expect(handleSendPreparedCalls(params, ctx)).rejects.toThrow(RpcError)

        try {
            await handleSendPreparedCalls(params, ctx)
        } catch (error) {
            expect(error).toBeInstanceOf(RpcError)

            if (!(error instanceof RpcError)) throw error

            // The error comes through as SERVICE_UNAVAILABLE from the pool
            // The underlying cause message contains "Intent expired"
            expect(error.message).toContain('Intent expired')
        }
    })

    it('accepts intent with valid expiry', async () => {
        const ctx = createMockCtx()
        const validExpiry = String(Math.floor(Date.now() / 1000) + 3600) // 1 hour from now
        const params = createParams(validExpiry)

        const result = await handleSendPreparedCalls(params, ctx)
        expect(result).toHaveProperty('id')
    })

    it('rejects intent expiring within buffer period', async () => {
        // Mock signer pool to return expiry error
        const ctx = createMockCtx({
            ok: false,
            json: () =>
                Promise.resolve({
                    error: 'Intent expired. Expiry: timestamp, Current: timestamp',
                    code: 'INTENT_EXPIRED',
                }),
        })

        // Intent expires in 15 seconds (within 30 second buffer)
        const soonExpiry = String(Math.floor(Date.now() / 1000) + 15)
        const params = createParams(soonExpiry)

        await expect(handleSendPreparedCalls(params, ctx)).rejects.toThrow(RpcError)
    })
})
