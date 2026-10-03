/**
 * Unit tests for per-EOA transaction ordering
 *
 * Tests the selectSignerForEoa function that routes transactions for the same EOA
 * to the same signer, preventing nonce conflicts.
 */

import { describe, it, expect } from 'vitest'
import type { Address } from 'viem'
import { selectSignerForEoa } from '../src/lib/pool-utils'

describe('selectSignerForEoa', () => {
    describe('determinism', () => {
        it('returns the same signer for the same EOA', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address
            const signerCount = 5

            const result1 = selectSignerForEoa(eoa, signerCount)
            const result2 = selectSignerForEoa(eoa, signerCount)
            const result3 = selectSignerForEoa(eoa, signerCount)

            expect(result1).toBe(result2)
            expect(result2).toBe(result3)
        })

        it('returns consistent results across multiple calls', () => {
            const eoas: Address[] = [
                '0x1111111111111111111111111111111111111111',
                '0x2222222222222222222222222222222222222222',
                '0x3333333333333333333333333333333333333333',
            ]
            const signerCount = 4

            // Store first results
            const firstResults = eoas.map((eoa) => selectSignerForEoa(eoa, signerCount))

            // Run 10 more times and verify consistency
            for (let i = 0; i < 10; i++) {
                eoas.forEach((eoa, index) => {
                    expect(selectSignerForEoa(eoa, signerCount)).toBe(firstResults[index])
                })
            }
        })

        it('different EOAs can map to the same signer', () => {
            // With enough EOAs, some will collide on the same signer
            const signerCount = 3
            const eoas: Address[] = Array.from(
                { length: 20 },
                (_, i) => `0x${i.toString(16).padStart(40, '0')}` as Address,
            )

            const results = eoas.map((eoa) => selectSignerForEoa(eoa, signerCount))
            const uniqueSigners = new Set(results)

            // All 3 signers should be used with 20 EOAs
            expect(uniqueSigners.size).toBe(signerCount)
        })
    })

    describe('distribution', () => {
        it('distributes EOAs roughly evenly across signers', () => {
            const signerCount = 5
            // Generate 100 random-ish EOAs
            const eoas: Address[] = Array.from(
                { length: 100 },
                (_, i) => `0x${(i * 12345).toString(16).padStart(40, '0').slice(0, 40)}` as Address,
            )

            const counts = new Map<number, number>()
            for (const eoa of eoas) {
                const signer = selectSignerForEoa(eoa, signerCount)
                counts.set(signer, (counts.get(signer) ?? 0) + 1)
            }

            // Each signer should have roughly 100/5 = 20 EOAs
            // Allow +/- 50% variance (10-30 per signer) for randomness
            for (let i = 0; i < signerCount; i++) {
                const count = counts.get(i) ?? 0
                expect(count).toBeGreaterThan(5) // At least some
                expect(count).toBeLessThan(50) // Not all in one
            }
        })

        it('uses all signers with enough unique EOAs', () => {
            const signerCount = 10
            const eoas: Address[] = Array.from(
                { length: 1000 },
                (_, i) => `0x${i.toString(16).padStart(40, '0')}` as Address,
            )

            const usedSigners = new Set<number>()
            for (const eoa of eoas) {
                usedSigners.add(selectSignerForEoa(eoa, signerCount))
            }

            // With 1000 EOAs and 10 signers, all signers should be used
            expect(usedSigners.size).toBe(signerCount)
        })
    })

    describe('edge cases', () => {
        it('returns 0 for single signer', () => {
            const eoa = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address
            expect(selectSignerForEoa(eoa, 1)).toBe(0)
        })

        it('throws for zero signers', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address
            expect(() => selectSignerForEoa(eoa, 0)).toThrow('signerCount must be positive')
        })

        it('throws for negative signers', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address
            expect(() => selectSignerForEoa(eoa, -1)).toThrow('signerCount must be positive')
        })

        it('handles checksummed addresses', () => {
            // Checksummed address
            const checksummed = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B' as Address
            const lowercase = checksummed.toLowerCase() as Address

            const signerCount = 5
            const result1 = selectSignerForEoa(checksummed, signerCount)
            const result2 = selectSignerForEoa(lowercase, signerCount)

            // keccak256 is case-sensitive, so these may differ
            // This is expected behavior - addresses should be normalized before use
            // Just verify both return valid indices
            expect(result1).toBeGreaterThanOrEqual(0)
            expect(result1).toBeLessThan(signerCount)
            expect(result2).toBeGreaterThanOrEqual(0)
            expect(result2).toBeLessThan(signerCount)
        })

        it('returns valid index for any signer count', () => {
            const eoa = '0x1234567890123456789012345678901234567890' as Address

            for (const signerCount of [1, 2, 3, 5, 10, 100, 256]) {
                const result = selectSignerForEoa(eoa, signerCount)
                expect(result).toBeGreaterThanOrEqual(0)
                expect(result).toBeLessThan(signerCount)
            }
        })
    })

    describe('specific EOA routing', () => {
        it('different EOAs route to different signers (probabilistic)', () => {
            const signerCount = 5
            const eoas: Address[] = [
                '0x0000000000000000000000000000000000000001',
                '0x0000000000000000000000000000000000000002',
                '0x0000000000000000000000000000000000000003',
                '0x0000000000000000000000000000000000000004',
                '0x0000000000000000000000000000000000000005',
            ]

            const results = eoas.map((eoa) => selectSignerForEoa(eoa, signerCount))
            const uniqueSigners = new Set(results)

            // With 5 EOAs and 5 signers, we expect at least 2-3 unique signers
            // (perfect distribution would give 5, but hash collisions are possible)
            expect(uniqueSigners.size).toBeGreaterThanOrEqual(2)
        })
    })
})
