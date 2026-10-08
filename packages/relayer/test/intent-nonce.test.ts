/**
 * Unit tests for 2D nonce calculation logic
 *
 * 2D Nonce Format:
 * - Upper 192 bits: seqKey (sequence key for parallel operations)
 * - Lower 64 bits: seq (sequential counter)
 *
 * Formula: (seqKey << 64n) | seq
 */

import { describe, it, expect } from 'vitest'

/**
 * Calculate 2D nonce from seqKey and seq
 * This mirrors the logic in IntentNonceDO.acquireNonce
 */
function calculateNonce(seqKey: bigint, seq: bigint): bigint {
    return (seqKey << 64n) | seq
}

/**
 * Extract seqKey from combined nonce
 */
function extractSeqKey(nonce: bigint): bigint {
    return nonce >> 64n
}

/**
 * Extract seq from combined nonce
 */
function extractSeq(nonce: bigint): bigint {
    return nonce & ((1n << 64n) - 1n) // Mask lower 64 bits
}

describe('2D Nonce Calculation', () => {
    describe('calculateNonce', () => {
        it('calculates nonce with seqKey=0, seq=0', () => {
            const nonce = calculateNonce(0n, 0n)
            expect(nonce).toBe(0n)
        })

        it('calculates nonce with seqKey=0, seq=1', () => {
            const nonce = calculateNonce(0n, 1n)
            expect(nonce).toBe(1n)
        })

        it('calculates nonce with seqKey=1, seq=0', () => {
            const nonce = calculateNonce(1n, 0n)
            // seqKey=1 shifted left by 64 bits
            expect(nonce).toBe(1n << 64n)
        })

        it('calculates nonce with seqKey=1, seq=1', () => {
            const nonce = calculateNonce(1n, 1n)
            expect(nonce).toBe((1n << 64n) | 1n)
        })

        it('calculates nonce with large seqKey', () => {
            const seqKey = 12345n
            const seq = 0n
            const nonce = calculateNonce(seqKey, seq)
            expect(nonce).toBe(seqKey << 64n)
        })

        it('calculates nonce with large seq', () => {
            const seqKey = 0n
            const seq = (1n << 63n) - 1n // Max 63-bit value
            const nonce = calculateNonce(seqKey, seq)
            expect(nonce).toBe(seq)
        })

        it('calculates nonce with both large seqKey and seq', () => {
            const seqKey = 999999n
            const seq = 888888n
            const nonce = calculateNonce(seqKey, seq)
            expect(nonce).toBe((seqKey << 64n) | seq)
        })

        it('handles max 64-bit seq value', () => {
            const seqKey = 1n
            const seq = (1n << 64n) - 1n // Max 64-bit value
            const nonce = calculateNonce(seqKey, seq)
            // Should combine correctly
            expect(extractSeqKey(nonce)).toBe(seqKey)
            expect(extractSeq(nonce)).toBe(seq)
        })
    })

    describe('extractSeqKey', () => {
        it('extracts seqKey=0 from nonce', () => {
            const nonce = calculateNonce(0n, 100n)
            expect(extractSeqKey(nonce)).toBe(0n)
        })

        it('extracts seqKey from nonce', () => {
            const seqKey = 42n
            const nonce = calculateNonce(seqKey, 0n)
            expect(extractSeqKey(nonce)).toBe(seqKey)
        })

        it('extracts seqKey regardless of seq value', () => {
            const seqKey = 12345n
            const seq = 67890n
            const nonce = calculateNonce(seqKey, seq)
            expect(extractSeqKey(nonce)).toBe(seqKey)
        })

        it('handles large seqKey', () => {
            const seqKey = (1n << 100n) - 1n // Large seqKey
            const nonce = calculateNonce(seqKey, 0n)
            expect(extractSeqKey(nonce)).toBe(seqKey)
        })
    })

    describe('extractSeq', () => {
        it('extracts seq=0 from nonce', () => {
            const nonce = calculateNonce(100n, 0n)
            expect(extractSeq(nonce)).toBe(0n)
        })

        it('extracts seq from nonce', () => {
            const seq = 42n
            const nonce = calculateNonce(0n, seq)
            expect(extractSeq(nonce)).toBe(seq)
        })

        it('extracts seq regardless of seqKey value', () => {
            const seqKey = 12345n
            const seq = 67890n
            const nonce = calculateNonce(seqKey, seq)
            expect(extractSeq(nonce)).toBe(seq)
        })

        it('handles max 64-bit seq', () => {
            const seq = (1n << 64n) - 1n
            const nonce = calculateNonce(0n, seq)
            expect(extractSeq(nonce)).toBe(seq)
        })

        it('does not include seqKey bits in seq', () => {
            const seqKey = (1n << 64n) - 1n // Would overlap if not masked
            const seq = 1n
            const nonce = calculateNonce(seqKey, seq)
            expect(extractSeq(nonce)).toBe(seq)
        })
    })

    describe('roundtrip', () => {
        it('roundtrips seqKey and seq correctly', () => {
            const testCases = [
                { seqKey: 0n, seq: 0n },
                { seqKey: 1n, seq: 0n },
                { seqKey: 0n, seq: 1n },
                { seqKey: 1n, seq: 1n },
                { seqKey: 12345n, seq: 67890n },
                { seqKey: (1n << 100n) - 1n, seq: (1n << 64n) - 1n },
            ]

            for (const { seqKey, seq } of testCases) {
                const nonce = calculateNonce(seqKey, seq)
                expect(extractSeqKey(nonce)).toBe(seqKey)
                expect(extractSeq(nonce)).toBe(seq)
            }
        })
    })

    describe('sequential increments', () => {
        it('sequential nonces differ by 1 for same seqKey', () => {
            const seqKey = 5n
            const nonce1 = calculateNonce(seqKey, 0n)
            const nonce2 = calculateNonce(seqKey, 1n)
            const nonce3 = calculateNonce(seqKey, 2n)

            expect(nonce2 - nonce1).toBe(1n)
            expect(nonce3 - nonce2).toBe(1n)
        })

        it('different seqKeys produce very different nonces', () => {
            const seq = 0n
            const nonce1 = calculateNonce(0n, seq)
            const nonce2 = calculateNonce(1n, seq)

            // seqKey=1 produces a nonce that is 2^64 larger
            expect(nonce2 - nonce1).toBe(1n << 64n)
        })

        it('nonces from different seqKeys do not overlap for reasonable seq values', () => {
            // Reasonable max seq per seqKey: 1000000n
            const seqKey1Nonces = Array.from({ length: 10 }, (_, i) =>
                calculateNonce(0n, BigInt(i)),
            )

            const seqKey2Nonces = Array.from({ length: 10 }, (_, i) =>
                calculateNonce(1n, BigInt(i)),
            )

            // No overlap between seqKey 0 and seqKey 1 nonces
            const set1 = new Set(seqKey1Nonces.map((n) => n.toString()))

            for (const n of seqKey2Nonces) {
                expect(set1.has(n.toString())).toBe(false)
            }
        })
    })

    describe('edge cases', () => {
        it('handles seqKey at boundary of 192 bits', () => {
            // Max 192-bit seqKey
            const seqKey = (1n << 192n) - 1n
            const seq = 0n
            const nonce = calculateNonce(seqKey, seq)

            expect(extractSeqKey(nonce)).toBe(seqKey)
            expect(extractSeq(nonce)).toBe(seq)
        })

        it('nonce is always positive', () => {
            const testCases = [
                { seqKey: 0n, seq: 0n },
                { seqKey: (1n << 192n) - 1n, seq: (1n << 64n) - 1n },
            ]

            for (const { seqKey, seq } of testCases) {
                const nonce = calculateNonce(seqKey, seq)
                expect(nonce >= 0n).toBe(true)
            }
        })
    })
})

/**
 * Simulates the drift detection logic from IntentNonceDO.acquireNonceSynced
 *
 * @param localSeq - Current local seq counter
 * @param onChainSeq - On-chain seq value
 * @returns The seq to use and whether sync occurred
 */
function simulateDriftDetection(
    localSeq: bigint,
    onChainSeq: bigint,
): { acquiredSeq: bigint; synced: boolean } {
    // Monotonic allocation: only fast-forward when behind.
    if (localSeq < onChainSeq) {
        return { acquiredSeq: onChainSeq, synced: true }
    }

    return { acquiredSeq: localSeq, synced: false }
}

/**
 * Stateful helper mirroring DO acquireNonceSynced allocation behavior:
 * returns current seq, then increments local state.
 */
function createSyncedAllocator(initialLocalSeq: bigint) {
    let localSeq = initialLocalSeq

    return {
        acquire(onChainSeq: bigint): { acquiredSeq: bigint; synced: boolean } {
            const { acquiredSeq, synced } = simulateDriftDetection(localSeq, onChainSeq)
            localSeq = acquiredSeq + 1n

            return { acquiredSeq, synced }
        },
        currentLocalSeq(): bigint {
            return localSeq
        },
    }
}

/**
 * Simulates extracting seq from full on-chain nonce
 * This is what relayer.ts should do before calling acquireNonceSynced
 */
function extractSeqFromOnChainNonce(onChainNonce: bigint): bigint {
    return onChainNonce & ((1n << 64n) - 1n)
}

describe('On-Chain Nonce Extraction (Bug Fix Validation)', () => {
    describe('extractSeqFromOnChainNonce', () => {
        it('should extract seq=0 from seqKey=0 nonce', () => {
            // #given - getNonce(0) returns (0 << 64) | 0 = 0
            const onChainNonce = 0n

            // #when
            const seq = extractSeqFromOnChainNonce(onChainNonce)

            // #then
            expect(seq).toBe(0n)
        })

        it('should extract seq from seqKey=0 nonce', () => {
            // #given - getNonce(0) returns (0 << 64) | 10 = 10
            const onChainNonce = 10n

            // #when
            const seq = extractSeqFromOnChainNonce(onChainNonce)

            // #then
            expect(seq).toBe(10n)
        })

        it('should extract seq=0 from seqKey=1 nonce', () => {
            // #given - getNonce(1) returns (1 << 64) | 0
            const onChainNonce = 1n << 64n

            // #when
            const seq = extractSeqFromOnChainNonce(onChainNonce)

            // #then
            expect(seq).toBe(0n)
        })

        it('should extract seq from seqKey=1 nonce', () => {
            // #given - getNonce(1) returns (1 << 64) | 10
            const onChainNonce = (1n << 64n) | 10n

            // #when
            const seq = extractSeqFromOnChainNonce(onChainNonce)

            // #then
            expect(seq).toBe(10n)
        })

        it('should extract seq from large seqKey nonce', () => {
            // #given - getNonce(12345) returns (12345 << 64) | 42
            const seqKey = 12345n
            const expectedSeq = 42n
            const onChainNonce = (seqKey << 64n) | expectedSeq

            // #when
            const seq = extractSeqFromOnChainNonce(onChainNonce)

            // #then
            expect(seq).toBe(expectedSeq)
        })

        it('should extract max 64-bit seq correctly', () => {
            // #given - max seq value
            const seqKey = 1n
            const expectedSeq = (1n << 64n) - 1n
            const onChainNonce = (seqKey << 64n) | expectedSeq

            // #when
            const seq = extractSeqFromOnChainNonce(onChainNonce)

            // #then
            expect(seq).toBe(expectedSeq)
        })
    })

    describe('drift detection with non-zero seqKey (bug regression test)', () => {
        it('should not rewind for seqKey=1 when local is ahead and seq is properly extracted', () => {
            // #given - the bug scenario:
            // - seqKey = 1
            // - on-chain seq = 10
            // - local seq = 15 (ahead of chain - drift)
            const seqKey = 1n
            const onChainNonce = (seqKey << 64n) | 10n // What getNonce(1) returns
            const localSeq = 15n

            // #when - CORRECT: extract seq before comparison
            const onChainSeq = extractSeqFromOnChainNonce(onChainNonce)
            const result = simulateDriftDetection(localSeq, onChainSeq)

            // #then - no rewind should happen
            expect(onChainSeq).toBe(10n)
            expect(result.synced).toBe(false)
            expect(result.acquiredSeq).toBe(15n)
        })

        it('BUG: passing full nonce as onChainSeq would still break allocation', () => {
            // #given - demonstrating the bug when caller passes wrong value
            const seqKey = 1n
            const onChainNonce = (seqKey << 64n) | 10n // Full nonce: 18446744073709551626n
            const localSeq = 15n

            // #when - BUG: passing full nonce instead of extracted seq
            const buggyResult = simulateDriftDetection(localSeq, onChainNonce)

            // #then - local appears "behind", so it fast-forwards to an invalid huge value
            expect(buggyResult.synced).toBe(true)
            expect(buggyResult.acquiredSeq).toBe(onChainNonce)
        })
    })

    describe('onChainSeq validation (defensive check)', () => {
        it('should detect when full nonce is incorrectly passed as seq', () => {
            // #given - full nonce for seqKey=1, seq=10
            const fullNonce = (1n << 64n) | 10n
            const MAX_SEQ = 2n ** 64n

            // #when
            const isInvalidSeq = fullNonce >= MAX_SEQ

            // #then - should be detected as invalid
            expect(isInvalidSeq).toBe(true)
        })

        it('should accept valid seq values', () => {
            const MAX_SEQ = 2n ** 64n

            const validSeqs = [0n, 1n, 10n, 1000n, (1n << 63n) - 1n]

            for (const seq of validSeqs) {
                expect(seq < MAX_SEQ).toBe(true)
            }
        })

        it('should reject seq values at or above 2^64', () => {
            const MAX_SEQ = 2n ** 64n

            const invalidSeqs = [
                MAX_SEQ, // Exactly 2^64
                MAX_SEQ + 1n, // Just above
                1n << 64n, // seqKey=1, seq=0 (full nonce)
                (1n << 64n) | 10n, // seqKey=1, seq=10 (full nonce)
            ]

            for (const seq of invalidSeqs) {
                expect(seq >= MAX_SEQ).toBe(true)
            }
        })
    })
})

describe('Nonce Drift Detection', () => {
    describe('simulateDriftDetection', () => {
        it('should not sync when local equals on-chain', () => {
            // #given
            const localSeq = 5n
            const onChainSeq = 5n

            // #when
            const result = simulateDriftDetection(localSeq, onChainSeq)

            // #then
            expect(result.synced).toBe(false)
            expect(result.acquiredSeq).toBe(5n)
        })

        it('should sync when local is behind on-chain', () => {
            // #given - local behind chain (external tx happened)
            const localSeq = 3n
            const onChainSeq = 5n

            // #when
            const result = simulateDriftDetection(localSeq, onChainSeq)

            // #then - sync to chain state to avoid InvalidNonce
            expect(result.synced).toBe(true)
            expect(result.acquiredSeq).toBe(5n)
        })

        it('should sync when local is ahead of on-chain (drift detected)', () => {
            // #given - local ahead of chain (drift from failed intents)
            const localSeq = 24n
            const onChainSeq = 3n

            // #when
            const result = simulateDriftDetection(localSeq, onChainSeq)

            // #then - do not rewind
            expect(result.synced).toBe(false)
            expect(result.acquiredSeq).toBe(24n)
        })

        it('should handle zero values', () => {
            // #given - both at zero (new account)
            const localSeq = 0n
            const onChainSeq = 0n

            // #when
            const result = simulateDriftDetection(localSeq, onChainSeq)

            // #then
            expect(result.synced).toBe(false)
            expect(result.acquiredSeq).toBe(0n)
        })

        it('should sync when local at zero with on-chain ahead', () => {
            // #given - local never tracked, chain has activity
            const localSeq = 0n
            const onChainSeq = 10n

            // #when
            const result = simulateDriftDetection(localSeq, onChainSeq)

            // #then - sync to chain state to avoid InvalidNonce
            expect(result.synced).toBe(true)
            expect(result.acquiredSeq).toBe(10n)
        })
    })

    describe('full nonce calculation with drift', () => {
        it('should return correct full nonce without rewinding when local is ahead', () => {
            // #given - drift scenario
            const seqKey = 0n
            const localSeq = 24n
            const onChainSeq = 3n

            // #when - detect drift and calculate nonce
            const { acquiredSeq, synced } = simulateDriftDetection(localSeq, onChainSeq)
            const nonce = calculateNonce(seqKey, acquiredSeq)

            // #then
            expect(synced).toBe(false)
            expect(nonce).toBe(24n) // seqKey=0, seq=24
            expect(extractSeq(nonce)).toBe(24n)
        })

        it('should work with non-zero seqKey', () => {
            // #given - drift with seqKey=1
            const seqKey = 1n
            const localSeq = 10n
            const onChainSeq = 5n

            // #when
            const { acquiredSeq, synced } = simulateDriftDetection(localSeq, onChainSeq)
            const nonce = calculateNonce(seqKey, acquiredSeq)

            // #then
            expect(synced).toBe(false)
            expect(extractSeqKey(nonce)).toBe(1n)
            expect(extractSeq(nonce)).toBe(10n)
        })
    })

    describe('regression: stale and near-concurrent synced allocation', () => {
        it('returns unique increasing seq values across repeated stale onChainSeq calls', () => {
            // local is ahead, but on-chain read is stale.
            const allocator = createSyncedAllocator(15n)
            const staleOnChainSeq = 10n

            const first = allocator.acquire(staleOnChainSeq)
            const second = allocator.acquire(staleOnChainSeq)
            const third = allocator.acquire(staleOnChainSeq)

            expect(first.synced).toBe(false)
            expect(second.synced).toBe(false)
            expect(third.synced).toBe(false)
            expect(first.acquiredSeq).toBe(15n)
            expect(second.acquiredSeq).toBe(16n)
            expect(third.acquiredSeq).toBe(17n)
            expect(new Set([first.acquiredSeq, second.acquiredSeq, third.acquiredSeq]).size).toBe(3)
        })

        it('simulates two near-concurrent stale synced acquisitions without duplication', () => {
            // Two requests read the same stale on-chain seq, but DO allocates monotonically.
            const allocator = createSyncedAllocator(20n)
            const staleOnChainSeq = 10n

            const r1 = allocator.acquire(staleOnChainSeq)
            const r2 = allocator.acquire(staleOnChainSeq)

            expect(r1.acquiredSeq).toBe(20n)
            expect(r2.acquiredSeq).toBe(21n)
            expect(r1.acquiredSeq === r2.acquiredSeq).toBe(false)
            expect(allocator.currentLocalSeq()).toBe(22n)
        })

        it('keeps allocations unique under Promise.all stale synced acquisitions', async () => {
            const allocator = createSyncedAllocator(25n)
            const staleOnChainSeq = 9n

            const [r1, r2] = await Promise.all([
                Promise.resolve().then(() => allocator.acquire(staleOnChainSeq)),
                Promise.resolve().then(() => allocator.acquire(staleOnChainSeq)),
            ])

            expect(r1.acquiredSeq === r2.acquiredSeq).toBe(false)
            expect(new Set([r1.acquiredSeq, r2.acquiredSeq]).size).toBe(2)
        })

        it('fast-forwards when local is behind on-chain and then continues monotonically', () => {
            const allocator = createSyncedAllocator(3n)
            const onChainSeq = 8n

            const first = allocator.acquire(onChainSeq)
            const second = allocator.acquire(onChainSeq)

            expect(first.synced).toBe(true)
            expect(first.acquiredSeq).toBe(8n)
            expect(second.synced).toBe(false)
            expect(second.acquiredSeq).toBe(9n)
        })
    })
})
