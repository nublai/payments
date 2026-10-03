/**
 * Unit tests for health RPC methods
 */

import { describe, it, expect, vi } from 'vitest'
import { handleHealth, handleLive, handleReady } from '../../src/rpc/methods/health'
import type { RpcContext } from '../../src/rpc/types'

// Mock RPC context
const createMockCtx = (overrides: Partial<RpcContext> = {}): RpcContext => ({
    env: {
        RPC_URL: 'https://example.com/rpc',
        CHAIN_IDS: '8453',
        ORCHESTRATOR_8453: '0x3456789012345678901234567890123456789012',
        SIMPLE_FUNDER_8453: '0x4567890123456789012345678901234567890123',
        SIMULATOR_8453: '0x5678901234567890123456789012345678901234',
        TOWNS_ACCOUNT_8453: '0x1234567890123456789012345678901234567890',
        ACCOUNT_PROXY_8453: '0x2345678901234567890123456789012345678901',
        SIMPLE_SETTLER_8453: '0x6789012345678901234567890123456789012345',
        ESCROW_8453: '0x7890123456789012345678901234567890123456',
        MULTI_SIG_SIGNER_8453: '0x8901234567890123456789012345678901234567',
        SIGNER_POOL: {
            idFromName: vi.fn().mockReturnValue('pool-id'),
            get: vi.fn().mockReturnValue({
                fetch: vi.fn().mockResolvedValue({
                    ok: true,
                    json: () => Promise.resolve({ signerCount: 1 }),
                }),
            }),
        },
    },
    ...overrides,
})

describe('wallet_health', () => {
    it('should return "ok" string', async () => {
        const ctx = createMockCtx()
        const result = await handleHealth(undefined, ctx)

        expect(result).toBe('ok')
    })
})

describe('wallet_live', () => {
    it('should return true when service is running', async () => {
        const ctx = createMockCtx()
        const result = await handleLive(undefined, ctx)

        expect(result).toBe(true)
    })
})

describe('wallet_ready', () => {
    it('should return true when dependencies are ready', async () => {
        const poolFetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ signerCount: 1 }),
        })
        const baseCtx = createMockCtx()
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: '0x2105' }),
        } as Response)
        const ctx = createMockCtx({
            env: {
                ...(baseCtx.env as Record<string, unknown>),
                SIGNER_POOL: {
                    idFromName: vi.fn().mockReturnValue('pool-id'),
                    get: vi.fn().mockReturnValue({
                        fetch: poolFetchMock,
                    }),
                },
            },
        })
        const result = await handleReady(undefined, ctx)

        expect(result).toBe(true)
        expect(poolFetchMock).toHaveBeenCalledWith('http://do/status?poolName=pool-8453')
        fetchMock.mockRestore()
    })

    // Note: More sophisticated readiness checks (RPC connectivity, etc.)
    // would require mocking fetch or the RPC endpoint
})
