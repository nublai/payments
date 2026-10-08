import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadContract, mockGetCode, mockCall } = vi.hoisted(() => ({
    mockReadContract: vi.fn(),
    mockGetCode: vi.fn(),
    mockCall: vi.fn() }))

vi.mock('../src/lib/viem-utils', () => ({
    createRelayerPublicClient: vi.fn().mockReturnValue({
        readContract: mockReadContract,
        getCode: mockGetCode,
        call: mockCall }),
    isEip7702Delegated: vi.fn().mockReturnValue(true) }))

import { RelayerService, type IntentNonceProvider } from '../src/services/relayer'
import { testIntentNonceProvider, testLogger, testRelayerConfig } from './helpers/relayer'

function makeRelayer(intentNonceProvider?: {
    acquireOrGetDraft: IntentNonceProvider['acquireOrGetDraft']
}): RelayerService {
    return new RelayerService(
        testRelayerConfig(),
        testLogger(),
        intentNonceProvider
            ? testIntentNonceProvider(intentNonceProvider.acquireOrGetDraft)
            : undefined,
    )
}

describe('RelayerService prepareIntent nonce behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.useRealTimers()
        mockReadContract.mockResolvedValue(0n)
        mockGetCode.mockResolvedValue('0xef0100')
        mockCall.mockResolvedValue({ data: '0x5208' })
    })

    it('defaults missing seqKey to lane 0 before draft allocation', async () => {
        const acquireOrGetDraft = vi.fn().mockResolvedValue({
            nonce: 0n,
            draftId: 'd-1',
            createdAtMs: 1000,
            expiresAtMs: 2000,
            fromCache: false })

        const relayer = makeRelayer({ acquireOrGetDraft })

        const result = await relayer.prepareIntent({
            eoa: '0x0000000000000000000000000000000000000001',
            calls: [{ to: '0x0000000000000000000000000000000000000002', value: '0x0', data: '0x' }] })

        expect(result.success).toBe(true)
        expect(acquireOrGetDraft).toHaveBeenCalledWith(
            '0x0000000000000000000000000000000000000001',
            0n,
            0n,
            undefined,
        )
    })

    it('uses explicit nonce without draft allocation path', async () => {
        const acquireOrGetDraft = vi.fn()
        const relayer = makeRelayer({ acquireOrGetDraft })

        const result = await relayer.prepareIntent({
            eoa: '0x0000000000000000000000000000000000000001',
            calls: [{ to: '0x0000000000000000000000000000000000000002', value: '0x0', data: '0x' }],
            nonce: '7' })

        expect(result.success).toBe(true)
        expect(result.typedData?.message.nonce).toBe(7n)
        expect(acquireOrGetDraft).not.toHaveBeenCalled()
    })

    it('produces stable digest for identical fixed-time inputs', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-02-13T12:00:00.000Z'))

        const acquireOrGetDraft = vi.fn().mockResolvedValue({
            nonce: 0n,
            draftId: 'd-1',
            createdAtMs: 1000,
            expiresAtMs: 2000,
            fromCache: false })

        const relayer = makeRelayer({ acquireOrGetDraft })

        const input = {
            eoa: '0x0000000000000000000000000000000000000001',
            calls: [{ to: '0x0000000000000000000000000000000000000002', value: '0x0', data: '0x' }] }

        const first = await relayer.prepareIntent(input)
        const second = await relayer.prepareIntent(input)

        expect(first.success).toBe(true)
        expect(second.success).toBe(true)
        expect(first.digest).toBeDefined()
        expect(second.digest).toBe(first.digest)
    })
})
