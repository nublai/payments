/**
 * Unit tests for capabilities RPC method
 */

import { describe, it, expect, vi } from 'vitest'
import { handleGetCapabilities } from '../../src/rpc/methods/getCapabilities'
import type { RpcContext } from '../../src/rpc/types'
import type { Env } from '../../src/types/env'

// Create mock environment
const createMockEnv = () => ({
    RPC_URL: 'https://mainnet.base.org',
    CHAIN_IDS: '8453',
    RELAYER_MNEMONIC: 'test mnemonic words',
    RELAYER_COUNT: '3',
    MAX_PENDING_PER_SIGNER: '16',
    MAX_PENDING_TOTAL: '1000',
    ACCOUNT: '0xAccount',
    ACCOUNT_PROXY: '0xAccountProxy',
    ORCHESTRATOR: '0x3456789012345678901234567890123456789012',
    SIMPLE_FUNDER: '0xSimpleFunder',
    SIMULATOR: '0xSimulator',
    // Chain-suffixed so prod/8453 resolves after the JSON was zeroed.
    // Unsuffixed placeholders stay incomplete, so an unknown chain still skips.
    ACCOUNT_8453: '0xAccount',
    ACCOUNT_PROXY_8453: '0xAccountProxy',
    ORCHESTRATOR_8453: '0x3456789012345678901234567890123456789012',
    SIMPLE_FUNDER_8453: '0xSimpleFunder',
    SIMULATOR_8453: '0xSimulator',
    SIMPLE_SETTLER_8453: '0xSimpleSettler',
    ESCROW_8453: '0xEscrow',
    MULTI_SIG_SIGNER_8453: '0xMultiSigSigner',
    SIGNER_POOL: {
        idFromName: vi.fn().mockReturnValue('pool-id'),
        get: vi.fn().mockReturnValue({
            fetch: vi.fn().mockResolvedValue({
                ok: true,
                json: () =>
                    Promise.resolve({
                        signerCount: 3,
                        totalCapacity: 1000,
                        totalPending: 0,
                        signers: [
                            {
                                index: 0,
                                address: '0xSigner0',
                                balance: '1000000000000000000',
                                capacity: 334,
                                pending: 0,
                            },
                            {
                                index: 1,
                                address: '0xSigner1',
                                balance: '2000000000000000000',
                                capacity: 333,
                                pending: 0,
                            },
                            {
                                index: 2,
                                address: '0xSigner2',
                                balance: '500000000000000000',
                                capacity: 333,
                                pending: 0,
                            },
                        ],
                    }),
            }),
        }),
    } as unknown as Env['SIGNER_POOL'],
})

const createMockCtx = (env = createMockEnv()): RpcContext => ({
    env: env as Partial<Env>,
})

describe('wallet_getCapabilities', () => {
    it('should return contracts and fees per chain (spec-compliant)', async () => {
        const ctx = createMockCtx()
        const result = await handleGetCapabilities(undefined, ctx)

        // Should have chain ID as key (hex format)
        expect(result).toHaveProperty('0x2105') // 8453 in hex

        const chainCaps = result['0x2105']

        // Should have contracts section with spec-compliant structure
        expect(chainCaps).toHaveProperty('contracts')
        expect(chainCaps.contracts).toHaveProperty('orchestrator')
        expect(chainCaps.contracts).toHaveProperty('delegation')
        expect(chainCaps.contracts).toHaveProperty('simulator')

        // Should have fees section with spec-compliant structure
        expect(chainCaps).toHaveProperty('fees')
        expect(chainCaps.fees).toHaveProperty('recipient')
        expect(chainCaps.fees).toHaveProperty('quoteConfig')
        expect(chainCaps.fees).toHaveProperty('tokens')
    })

    it('should filter by chain_ids when provided', async () => {
        const ctx = createMockCtx()

        // Request only specific chain
        const result = await handleGetCapabilities({ chains: ['0x2105'] }, ctx)

        // Should only have the requested chain
        expect(Object.keys(result)).toContain('0x2105')
    })

    it('should return empty object for unknown chain filter', async () => {
        const ctx = createMockCtx()

        // Request a chain that doesn't match
        const result = await handleGetCapabilities({ chains: ['0x1'] }, ctx)

        // Should not have the unknown chain (we only support the configured chain)
        expect(result).not.toHaveProperty('0x1')
    })

    it('should have quoteConfig with ttlSeconds', async () => {
        const ctx = createMockCtx()
        const result = await handleGetCapabilities(undefined, ctx)

        const chainCaps = result['0x2105']

        expect(chainCaps.fees.quoteConfig).toHaveProperty('ttlSeconds')
        expect(typeof chainCaps.fees.quoteConfig.ttlSeconds).toBe('number')
    })

    it('should include signer addresses and balances in pool info', async () => {
        const ctx = createMockCtx()
        const result = await handleGetCapabilities(undefined, ctx)

        const chainCaps = result['0x2105']

        expect(chainCaps.pool).toHaveProperty('signers')
        expect(chainCaps.pool.signers).toHaveLength(3)

        const signer = chainCaps.pool.signers[0]
        expect(signer).toHaveProperty('index', 0)
        expect(signer).toHaveProperty('address', '0xSigner0')
        expect(signer).toHaveProperty('balance', '1000000000000000000')
        expect(signer).toHaveProperty('capacity')
        expect(signer).toHaveProperty('pending')
        expect(signer).toHaveProperty('paused')
    })
})
