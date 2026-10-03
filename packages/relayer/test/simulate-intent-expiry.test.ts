import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const { mockGetCode, mockCall } = vi.hoisted(() => ({
    mockGetCode: vi.fn(),
    mockCall: vi.fn(),
}))

vi.mock('../src/lib/viem-utils', () => ({
    createRelayerPublicClient: vi.fn().mockReturnValue({
        getCode: mockGetCode,
        call: mockCall,
    }),
    isEip7702Delegated: vi.fn().mockReturnValue(true),
}))

import { RelayerService } from '../src/services/relayer'

describe('simulateIntent expiry unit guard', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetCode.mockResolvedValue('0xef0100')
        mockCall.mockResolvedValue({ data: '0x5208' })
    })

    it('rejects millisecond expiry values', async () => {
        const relayer = new RelayerService(
            {
                chainId: 8453,
                rpcUrl: 'http://localhost:8545',
                contracts: {
                    orchestrator: '0x0000000000000000000000000000000000000011',
                    simulator: '0x0000000000000000000000000000000000000022',
                } as any,
            },
            {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            } as any,
        )

        const result = await relayer.simulateIntent({
            eoa: '0x0000000000000000000000000000000000000001' as Address,
            calls: [
                {
                    to: '0x0000000000000000000000000000000000000002',
                    value: '0x0',
                    data: '0x',
                },
            ],
            expiry: '1700000000000',
        })

        expect(result.success).toBe(false)
        expect(result.error).toContain('appears to be milliseconds')
        expect(mockCall).not.toHaveBeenCalled()
    })
})
