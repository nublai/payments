import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetCode, mockCall } = vi.hoisted(() => ({
    mockGetCode: vi.fn(),
    mockCall: vi.fn() }))

vi.mock('../src/lib/viem-utils', () => ({
    createRelayerPublicClient: vi.fn().mockReturnValue({
        getCode: mockGetCode,
        call: mockCall }),
    isEip7702Delegated: vi.fn().mockReturnValue(true) }))

import { RelayerService } from '../src/services/relayer'
import { testLogger, testRelayerConfig } from './helpers/relayer'

describe('simulateIntent expiry unit guard', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetCode.mockResolvedValue('0xef0100')
        mockCall.mockResolvedValue({ data: '0x5208' })
    })

    it('rejects millisecond expiry values', async () => {
        const relayer = new RelayerService(testRelayerConfig(), testLogger())

        const result = await relayer.simulateIntent({
            eoa: '0x0000000000000000000000000000000000000001',
            calls: [
                {
                    to: '0x0000000000000000000000000000000000000002',
                    value: '0x0',
                    data: '0x' },
            ],
            expiry: '1700000000000' })

        expect(result.success).toBe(false)
        expect(result.error).toContain('appears to be milliseconds')
        expect(mockCall).not.toHaveBeenCalled()
    })
})
