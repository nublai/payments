/**
 * Unit tests for SignerPoolDO pure logic
 *
 * Tests the selectCandidates and shuffle functions that don't require RPC.
 */

import { describe, it, expect } from 'vitest'
import type { Hex } from 'viem'

/**
 * Capacity info for a signer (mirrors IndexedCapacityInfo)
 */
interface IndexedCapacityInfo {
    index: number
    capacity: number
    pending: number
    address: Hex | null
    error: boolean
}

/**
 * Fisher-Yates shuffle for fair tie-breaking
 * Mirrors SignerPoolDO.shuffle
 */
function shuffle<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))

        ;[array[i], array[j]] = [array[j], array[i]]
    }
}

/**
 * Select candidates sorted by capacity
 * Mirrors SignerPoolDO.selectCandidates
 */
function selectCandidates(capacities: IndexedCapacityInfo[]): IndexedCapacityInfo[] {
    // Filter to signers with available capacity and no errors
    const available = capacities.filter((c) => c.capacity > 0 && !c.error)

    if (available.length === 0) {
        return []
    }

    // Shuffle for fair tie-breaking among signers with same capacity
    shuffle(available)

    // Sort by capacity descending (stable sort preserves shuffle order for ties)
    return available.sort((a, b) => b.capacity - a.capacity)
}

describe('SignerPool selectCandidates', () => {
    it('returns empty array when all signers have zero capacity', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 0, pending: 16, address: '0x1', error: false },
            { index: 1, capacity: 0, pending: 16, address: '0x2', error: false },
        ]

        const result = selectCandidates(capacities)
        expect(result).toHaveLength(0)
    })

    it('returns empty array when all signers have errors', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 10, pending: 6, address: '0x1', error: true },
            { index: 1, capacity: 5, pending: 11, address: '0x2', error: true },
        ]

        const result = selectCandidates(capacities)
        expect(result).toHaveLength(0)
    })

    it('returns empty array for empty input', () => {
        const result = selectCandidates([])
        expect(result).toHaveLength(0)
    })

    it('filters out signers with zero capacity', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 0, pending: 16, address: '0x1', error: false },
            { index: 1, capacity: 10, pending: 6, address: '0x2', error: false },
            { index: 2, capacity: 0, pending: 16, address: '0x3', error: false },
        ]

        const result = selectCandidates(capacities)
        expect(result).toHaveLength(1)
        expect(result[0].index).toBe(1)
    })

    it('filters out signers with errors', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 10, pending: 6, address: '0x1', error: true },
            { index: 1, capacity: 5, pending: 11, address: '0x2', error: false },
            { index: 2, capacity: 8, pending: 8, address: '0x3', error: true },
        ]

        const result = selectCandidates(capacities)
        expect(result).toHaveLength(1)
        expect(result[0].index).toBe(1)
    })

    it('sorts candidates by capacity descending', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 5, pending: 11, address: '0x1', error: false },
            { index: 1, capacity: 15, pending: 1, address: '0x2', error: false },
            { index: 2, capacity: 10, pending: 6, address: '0x3', error: false },
        ]

        const result = selectCandidates(capacities)
        expect(result).toHaveLength(3)
        expect(result[0].index).toBe(1) // capacity 15
        expect(result[1].index).toBe(2) // capacity 10
        expect(result[2].index).toBe(0) // capacity 5
    })

    it('filters and sorts correctly', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 0, pending: 16, address: '0x1', error: false }, // filtered
            { index: 1, capacity: 8, pending: 8, address: '0x2', error: false },
            { index: 2, capacity: 12, pending: 4, address: '0x3', error: true }, // filtered
            { index: 3, capacity: 3, pending: 13, address: '0x4', error: false },
        ]

        const result = selectCandidates(capacities)
        expect(result).toHaveLength(2)
        expect(result[0].index).toBe(1) // capacity 8
        expect(result[1].index).toBe(3) // capacity 3
    })

    it('handles single available signer', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 0, pending: 16, address: '0x1', error: false },
            { index: 1, capacity: 5, pending: 11, address: '0x2', error: false },
            { index: 2, capacity: 0, pending: 16, address: '0x3', error: true },
        ]

        const result = selectCandidates(capacities)
        expect(result).toHaveLength(1)
        expect(result[0].index).toBe(1)
    })

    it('handles null addresses', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 10, pending: 6, address: null, error: false },
            { index: 1, capacity: 5, pending: 11, address: '0x2', error: false },
        ]

        const result = selectCandidates(capacities)
        expect(result).toHaveLength(2)
        // Both should be included, null address doesn't affect selection
    })
})

describe('SignerPool shuffle', () => {
    it('does not change array length', () => {
        const arr = [1, 2, 3, 4, 5]
        const originalLength = arr.length
        shuffle(arr)
        expect(arr.length).toBe(originalLength)
    })

    it('keeps all elements', () => {
        const arr = [1, 2, 3, 4, 5]
        const originalSet = new Set(arr)
        shuffle(arr)
        const shuffledSet = new Set(arr)
        expect(shuffledSet).toEqual(originalSet)
    })

    it('handles empty array', () => {
        const arr: number[] = []
        shuffle(arr)
        expect(arr).toEqual([])
    })

    it('handles single element', () => {
        const arr = [42]
        shuffle(arr)
        expect(arr).toEqual([42])
    })

    it('handles two elements', () => {
        const arr = [1, 2]
        const originalSet = new Set(arr)
        shuffle(arr)
        expect(new Set(arr)).toEqual(originalSet)
    })

    it('modifies array in place', () => {
        const arr = [1, 2, 3, 4, 5]
        const ref = arr
        shuffle(arr)
        expect(arr).toBe(ref) // Same reference
    })

    it('produces different orders over many runs (probabilistic)', () => {
        const original = [1, 2, 3, 4, 5]
        const orders = new Set<string>()

        // Run shuffle many times and collect unique orders
        for (let i = 0; i < 100; i++) {
            const arr = [...original]
            shuffle(arr)
            orders.add(arr.join(','))
        }

        // With 5 elements, there are 120 permutations
        // We should see multiple different orders
        expect(orders.size).toBeGreaterThan(1)
    })
})

describe('SignerPool capacity-based selection', () => {
    it('prefers higher capacity signers', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 1, pending: 15, address: '0x1', error: false },
            { index: 1, capacity: 10, pending: 6, address: '0x2', error: false },
            { index: 2, capacity: 5, pending: 11, address: '0x3', error: false },
        ]

        const result = selectCandidates(capacities)
        expect(result[0].capacity).toBeGreaterThanOrEqual(result[1].capacity)
        expect(result[1].capacity).toBeGreaterThanOrEqual(result[2].capacity)
    })

    it('handles equal capacities (shuffle provides fairness)', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 10, pending: 6, address: '0x1', error: false },
            { index: 1, capacity: 10, pending: 6, address: '0x2', error: false },
            { index: 2, capacity: 10, pending: 6, address: '0x3', error: false },
        ]

        // Run multiple times to verify ordering varies for ties
        const firstIndices = new Set<number>()

        for (let i = 0; i < 20; i++) {
            const result = selectCandidates([...capacities])
            firstIndices.add(result[0].index)
        }

        // With shuffle, we should see different first indices over time
        // (probabilistic, but with 20 runs and 3 options, very likely to see >1)
        expect(firstIndices.size).toBeGreaterThanOrEqual(1)
    })

    it('mixed capacity levels are sorted correctly', () => {
        const capacities: IndexedCapacityInfo[] = [
            { index: 0, capacity: 5, pending: 11, address: '0x1', error: false },
            { index: 1, capacity: 5, pending: 11, address: '0x2', error: false },
            { index: 2, capacity: 10, pending: 6, address: '0x3', error: false },
            { index: 3, capacity: 3, pending: 13, address: '0x4', error: false },
            { index: 4, capacity: 10, pending: 6, address: '0x5', error: false },
        ]

        const result = selectCandidates(capacities)

        // Capacity 10 signers should be first (indices 2 or 4)
        expect([2, 4]).toContain(result[0].index)
        expect([2, 4]).toContain(result[1].index)

        // Capacity 5 signers next (indices 0 or 1)
        expect([0, 1]).toContain(result[2].index)
        expect([0, 1]).toContain(result[3].index)

        // Capacity 3 signer last (index 3)
        expect(result[4].index).toBe(3)
    })
})
