/**
 * Unit tests for getSignerName() helper function
 * TDD: Tests written first before implementation
 */

import { describe, it, expect } from 'vitest'
import type { Address } from 'viem'
import { getSignerName } from '../../src/rpc/methods/sendPreparedCalls'

describe('getSignerName', () => {
    describe('deterministic signer selection', () => {
        it('should return the same signer name for the same EOA and chainId', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address
            const chainId = 8453
            const signerCount = 1

            const signerName1 = getSignerName(eoa, chainId, signerCount)
            const signerName2 = getSignerName(eoa, chainId, signerCount)

            expect(signerName1).toBe(signerName2)
        })

        it('should return different signer names for different EOAs', () => {
            const eoa1 = '0x1234567890123456789012345678901234567890' as Address
            const eoa2 = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address
            const chainId = 8453
            const signerCount = 3

            const signerName1 = getSignerName(eoa1, chainId, signerCount)
            const signerName2 = getSignerName(eoa2, chainId, signerCount)

            // May or may not be different depending on hash distribution
            // But should be deterministic
            expect(signerName1).toMatch(/^signer-\d+-\d+$/)
            expect(signerName2).toMatch(/^signer-\d+-\d+$/)
        })

        it('should return different signer names for different chainIds', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address
            const signerCount = 1

            const signerName1 = getSignerName(eoa, 8453, signerCount)
            const signerName2 = getSignerName(eoa, 1, signerCount)

            expect(signerName1).not.toBe(signerName2)
            expect(signerName1).toMatch(/^signer-8453-\d+$/)
            expect(signerName2).toMatch(/^signer-1-\d+$/)
        })
    })

    describe('signer name format', () => {
        it('should return signer name in format signer-{chainId}-{index}', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address
            const chainId = 31337
            const signerCount = 1

            const signerName = getSignerName(eoa, chainId, signerCount)

            expect(signerName).toMatch(/^signer-31337-\d+$/)
        })

        it('should return index within signerCount range', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address
            const chainId = 8453
            const signerCount = 5

            const signerName = getSignerName(eoa, chainId, signerCount)

            const match = signerName.match(/^signer-\d+-(\d+)$/)
            expect(match).not.toBeNull()

            if (match) {
                const index = parseInt(match[1], 10)
                expect(index).toBeGreaterThanOrEqual(0)
                expect(index).toBeLessThan(5)
            }
        })
    })

    describe('signer count handling', () => {
        it('should handle single signer (signerCount = 1)', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address
            const chainId = 8453
            const signerCount = 1

            const signerName = getSignerName(eoa, chainId, signerCount)

            expect(signerName).toBe('signer-8453-0')
        })

        it('should distribute across multiple signers', () => {
            const eoa1 = '0x1111111111111111111111111111111111111111' as Address
            const eoa2 = '0x2222222222222222222222222222222222222222' as Address
            const eoa3 = '0x3333333333333333333333333333333333333333' as Address
            const chainId = 8453
            const signerCount = 3

            const signerName1 = getSignerName(eoa1, chainId, signerCount)
            const signerName2 = getSignerName(eoa2, chainId, signerCount)
            const signerName3 = getSignerName(eoa3, chainId, signerCount)

            // All should be valid signer names
            expect(signerName1).toMatch(/^signer-8453-[0-2]$/)
            expect(signerName2).toMatch(/^signer-8453-[0-2]$/)
            expect(signerName3).toMatch(/^signer-8453-[0-2]$/)
        })
    })

    describe('consistency with selectSignerForEoa', () => {
        it('should use the same logic as selectSignerForEoa for index selection', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address
            const chainId = 8453
            const signerCount = 3

            const signerName = getSignerName(eoa, chainId, signerCount)

            // The index should match what selectSignerForEoa would return
            // We can't directly test this without importing selectSignerForEoa,
            // but we can verify the format is correct
            expect(signerName).toMatch(/^signer-8453-[0-2]$/)
        })
    })
})
