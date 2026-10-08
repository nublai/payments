import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForDelegationCode } from '../../src/rpc/methods/upgradeAccount'

const testAddress = '0xFF159018e548D710397f885a2c19bC58a2D499Da'

const delegatedCode = '0xef0100ee06c19146427bdd5abb702579f3b0568b24bf6f'

describe('waitForDelegationCode', () => {
    beforeEach(() => {
        // Running in single-worker mode can inherit fake timers from prior files.
        vi.useRealTimers()
    })

    it('returns immediately when latest code is delegated', async () => {
        const getCode = vi.fn().mockResolvedValue(delegatedCode)

        const code = await waitForDelegationCode({ getCode }, testAddress, undefined, {
            maxAttempts: 3,
            initialDelayMs: 1,
            maxDelayMs: 1 })

        expect(code).toBe(delegatedCode)
        expect(getCode).toHaveBeenCalledTimes(1)
    })

    it('recovers when latest code is stale initially then catches up', async () => {
        const getCode = vi.fn().mockResolvedValueOnce('0x').mockResolvedValueOnce(delegatedCode)

        const code = await waitForDelegationCode({ getCode }, testAddress, undefined, {
            maxAttempts: 3,
            initialDelayMs: 1,
            maxDelayMs: 1 })

        expect(code).toBe(delegatedCode)
        expect(getCode).toHaveBeenCalledTimes(2)
    })

    it('returns delegated code from receipt block when latest is stale', async () => {
        const getCode = vi.fn().mockImplementation(async (args: { blockNumber?: bigint }) => {
            if (args.blockNumber !== undefined) {
                return delegatedCode
            }

            return '0x'
        })

        const code = await waitForDelegationCode({ getCode }, testAddress, 41804768n, {
            maxAttempts: 2,
            initialDelayMs: 1,
            maxDelayMs: 1 })

        expect(code).toBe(delegatedCode)
        expect(getCode).toHaveBeenCalledTimes(2)
    })

    it('returns last observed code when delegation never appears', async () => {
        const getCode = vi.fn().mockResolvedValue('0x')

        const code = await waitForDelegationCode({ getCode }, testAddress, 41804768n, {
            maxAttempts: 2,
            initialDelayMs: 1,
            maxDelayMs: 1 })

        expect(code).toBe('0x')
    })
})
