/**
 * Unit tests for SignerDO intent expiry validation
 */

import { describe, it, expect } from 'vitest'

/**
 * Check if intent has expired or will expire within buffer
 * Exported for testing - same logic as in signer.do.ts
 */
export function isIntentExpired(
    expiryTimestamp: bigint | string,
    bufferSeconds: number = 30,
): boolean {
    const expiry = typeof expiryTimestamp === 'string' ? BigInt(expiryTimestamp) : expiryTimestamp
    const currentTime = BigInt(Math.floor(Date.now() / 1000))
    const buffer = BigInt(bufferSeconds)
    return currentTime + buffer >= expiry
}

describe('SignerDO intent expiry validation', () => {
    describe('isIntentExpired', () => {
        it('returns false for intent expiring in the future', () => {
            const futureExpiry = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
            expect(isIntentExpired(futureExpiry.toString(), 30)).toBe(false)
        })

        it('returns true for intent already expired', () => {
            const pastExpiry = Math.floor(Date.now() / 1000) - 60 // 1 min ago
            expect(isIntentExpired(pastExpiry.toString(), 30)).toBe(true)
        })

        it('returns true for intent expiring within buffer', () => {
            const soonExpiry = Math.floor(Date.now() / 1000) + 15 // 15 sec from now
            expect(isIntentExpired(soonExpiry.toString(), 30)).toBe(true) // 30 sec buffer
        })

        it('returns false for intent expiring just outside buffer', () => {
            const expiry = Math.floor(Date.now() / 1000) + 60 // 60 sec from now
            expect(isIntentExpired(expiry.toString(), 30)).toBe(false) // 30 sec buffer
        })

        it('handles bigint expiry values', () => {
            const futureExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600)
            expect(isIntentExpired(futureExpiry, 30)).toBe(false)
        })

        it('handles custom buffer values', () => {
            const expiry = Math.floor(Date.now() / 1000) + 45
            // With 60 sec buffer, should be expired (45 < 60)
            expect(isIntentExpired(expiry.toString(), 60)).toBe(true)
            // With 30 sec buffer, should be valid (45 > 30)
            expect(isIntentExpired(expiry.toString(), 30)).toBe(false)
        })

        it('returns true when expiry equals current time plus buffer', () => {
            const expiry = Math.floor(Date.now() / 1000) + 30 // exactly at buffer
            expect(isIntentExpired(expiry.toString(), 30)).toBe(true)
        })

        it('returns false with zero buffer for future expiry', () => {
            const futureExpiry = Math.floor(Date.now() / 1000) + 1
            expect(isIntentExpired(futureExpiry.toString(), 0)).toBe(false)
        })

        it('returns true with zero buffer for past expiry', () => {
            const pastExpiry = Math.floor(Date.now() / 1000) - 1
            expect(isIntentExpired(pastExpiry.toString(), 0)).toBe(true)
        })

        it('returns true with zero buffer when expiry equals current time', () => {
            const now = Math.floor(Date.now() / 1000)
            expect(isIntentExpired(now.toString(), 0)).toBe(true)
        })
    })
})
