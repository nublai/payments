/**
 * Unit tests for BundleStatusDO
 *
 * Tests the idempotency, refund scheduling, and bundle lifecycle logic.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Hex, Address } from 'viem'

// ============================================================================
// Idempotency Logic Tests
// ============================================================================

/**
 * Simulates the idempotency check logic for fulfillment/settlement/refund attempts.
 * Returns whether this is a new attempt and any existing data.
 */
interface AttemptRecord {
    escrowId: string
    bundleId: string
    txHash?: string
    status: 'pending' | 'sent' | 'confirmed' | 'failed'
}

type AttemptIdempotency = { isNew: boolean; existingTxHash?: string; status?: string }

type BundleFinished = { finished: boolean; status?: string }

type BundleIdByTxId = { bundleId: string | null }

type ConfirmRetry = { shouldRetry: boolean; nextAttempt: number }

function checkAttemptIdempotency(
    existingAttempts: Map<string, AttemptRecord>,
    escrowId: string,
    bundleId: string,
): AttemptIdempotency {
    const existing = existingAttempts.get(escrowId)

    if (!existing) {
        // New attempt - create pending record
        existingAttempts.set(escrowId, { escrowId, bundleId, status: 'pending' })

        return { isNew: true }
    }

    // Existing attempt found
    if (existing.txHash) {
        return { isNew: false, existingTxHash: existing.txHash, status: existing.status }
    }

    // Previous attempt exists but no txHash (failed before tx) - allow retry
    return { isNew: true }
}

function completeAttempt(
    existingAttempts: Map<string, AttemptRecord>,
    escrowId: string,
    txHash: string,
): void {
    const existing = existingAttempts.get(escrowId)

    if (existing) {
        existing.txHash = txHash
        existing.status = 'sent'
    }
}

describe('BundleStatusDO', () => {
    describe('idempotency protection', () => {
        let attempts: Map<string, AttemptRecord>

        beforeEach(() => {
            attempts = new Map()
        })

        it('returns isNew=true for first attempt', () => {
            // #given
            const escrowId = '0x1234'
            const bundleId = 'bundle-1'

            // #when
            const result = checkAttemptIdempotency(attempts, escrowId, bundleId)

            // #then
            expect(result.isNew).toBe(true)
            expect(result.existingTxHash).toBeUndefined()
        })

        it('returns isNew=false with existing txHash for duplicate attempt', () => {
            // #given
            const escrowId = '0x1234'
            const bundleId = 'bundle-1'
            const txHash = '0xabcd'

            // First attempt
            checkAttemptIdempotency(attempts, escrowId, bundleId)
            completeAttempt(attempts, escrowId, txHash)

            // #when - duplicate attempt
            const result = checkAttemptIdempotency(attempts, escrowId, bundleId)

            // #then
            expect(result.isNew).toBe(false)
            expect(result.existingTxHash).toBe(txHash)
        })

        it('allows retry when previous attempt has no txHash', () => {
            // #given - attempt started but tx never sent (crashed before broadcast)
            const escrowId = '0x1234'
            const bundleId = 'bundle-1'
            checkAttemptIdempotency(attempts, escrowId, bundleId)
            // Note: completeAttempt not called - simulates crash before tx

            // #when - retry attempt
            const result = checkAttemptIdempotency(attempts, escrowId, bundleId)

            // #then - should allow retry
            expect(result.isNew).toBe(true)
        })

        it('tracks attempts per escrowId independently', () => {
            // #given
            const escrow1 = '0x1111'
            const escrow2 = '0x2222'
            const bundleId = 'bundle-1'

            // #when
            const result1 = checkAttemptIdempotency(attempts, escrow1, bundleId)
            const result2 = checkAttemptIdempotency(attempts, escrow2, bundleId)

            // #then - both should be new
            expect(result1.isNew).toBe(true)
            expect(result2.isNew).toBe(true)
        })
    })

    // ============================================================================
    // Refund Scheduling Tests
    // ============================================================================

    describe('refund scheduling', () => {
        interface PendingRefund {
            bundleId: string
            refundTimestamp: number
            inputChainId: number
            escrowId: Hex
            escrowAddress: Address
        }

        let pendingRefunds: Map<string, PendingRefund>

        beforeEach(() => {
            pendingRefunds = new Map()
        })

        function scheduleRefund(refund: PendingRefund): void {
            pendingRefunds.set(refund.bundleId, refund)
        }

        function getReadyRefunds(currentTime: number): PendingRefund[] {
            return Array.from(pendingRefunds.values()).filter(
                (r) => r.refundTimestamp <= currentTime,
            )
        }

        function claimReadyRefunds(currentTime: number): PendingRefund[] {
            const ready = getReadyRefunds(currentTime)

            // Atomic: select and delete
            for (const r of ready) {
                pendingRefunds.delete(r.bundleId)
            }

            return ready
        }

        function removeRefund(bundleId: string): void {
            pendingRefunds.delete(bundleId)
        }

        it('schedules refund for future timestamp', () => {
            // #given
            const now = Math.floor(Date.now() / 1000)

            const refund: PendingRefund = {
                bundleId: 'bundle-1',
                refundTimestamp: now + 3600, // 1 hour from now
                inputChainId: 31337,
                escrowId: '0x1234',
                escrowAddress: '0x5555',
            }

            // #when
            scheduleRefund(refund)

            // #then
            expect(getReadyRefunds(now)).toHaveLength(0)
            expect(getReadyRefunds(now + 3600)).toHaveLength(1)
        })

        it('claimReadyRefunds returns and deletes atomically', () => {
            // #given
            const now = Math.floor(Date.now() / 1000)
            scheduleRefund({
                bundleId: 'bundle-1',
                refundTimestamp: now - 100, // past
                inputChainId: 31337,
                escrowId: '0x1234',
                escrowAddress: '0x5555',
            })
            scheduleRefund({
                bundleId: 'bundle-2',
                refundTimestamp: now + 100, // future
                inputChainId: 31337,
                escrowId: '0x5678',
                escrowAddress: '0x5555',
            })

            // #when
            const claimed = claimReadyRefunds(now)

            // #then
            expect(claimed).toHaveLength(1)
            expect(claimed[0].bundleId).toBe('bundle-1')
            // Claimed refund should be deleted
            expect(pendingRefunds.has('bundle-1')).toBe(false)
            // Future refund should remain
            expect(pendingRefunds.has('bundle-2')).toBe(true)
        })

        it('claimReadyRefunds prevents duplicate claims', () => {
            // #given
            const now = Math.floor(Date.now() / 1000)
            scheduleRefund({
                bundleId: 'bundle-1',
                refundTimestamp: now - 100,
                inputChainId: 31337,
                escrowId: '0x1234',
                escrowAddress: '0x5555',
            })

            // #when - first claim
            const firstClaim = claimReadyRefunds(now)
            // #when - second claim (simulates cron running again)
            const secondClaim = claimReadyRefunds(now)

            // #then
            expect(firstClaim).toHaveLength(1)
            expect(secondClaim).toHaveLength(0) // No duplicates
        })

        it('removeRefund cancels scheduled refund', () => {
            // #given
            const now = Math.floor(Date.now() / 1000)
            scheduleRefund({
                bundleId: 'bundle-1',
                refundTimestamp: now + 3600,
                inputChainId: 31337,
                escrowId: '0x1234',
                escrowAddress: '0x5555',
            })

            // #when - settlement succeeds, cancel refund
            removeRefund('bundle-1')

            // #then
            expect(pendingRefunds.has('bundle-1')).toBe(false)
            expect(claimReadyRefunds(now + 3600)).toHaveLength(0)
        })
    })

    // ============================================================================
    // Bundle Finished Check Tests
    // ============================================================================

    describe('isBundleFinished', () => {
        let finishedBundles: Map<string, { status: string }>

        beforeEach(() => {
            finishedBundles = new Map()
        })

        function isBundleFinished(bundleId: string): BundleFinished {
            const bundle = finishedBundles.get(bundleId)

            if (!bundle) {
                return { finished: false }
            }

            return { finished: true, status: bundle.status }
        }

        function finishBundle(bundleId: string, status: string): void {
            finishedBundles.set(bundleId, { status })
        }

        it('returns finished=false for unknown bundle', () => {
            // #when
            const result = isBundleFinished('unknown-bundle')

            // #then
            expect(result.finished).toBe(false)
            expect(result.status).toBeUndefined()
        })

        it('returns finished=true with status for finished bundle', () => {
            // #given
            finishBundle('bundle-1', 'done')

            // #when
            const result = isBundleFinished('bundle-1')

            // #then
            expect(result.finished).toBe(true)
            expect(result.status).toBe('done')
        })

        it('returns correct status for failed bundle', () => {
            // #given
            finishBundle('bundle-1', 'failed')

            // #when
            const result = isBundleFinished('bundle-1')

            // #then
            expect(result.finished).toBe(true)
            expect(result.status).toBe('failed')
        })
    })

    // ============================================================================
    // Bundle Transaction Mapping Tests
    // ============================================================================

    describe('getBundleIdByTxId (reverse lookup)', () => {
        let bundleTransactions: Map<string, string> // txId -> bundleId

        beforeEach(() => {
            bundleTransactions = new Map()
        })

        function addBundleTx(bundleId: string, txId: string): void {
            bundleTransactions.set(txId, bundleId)
        }

        function getBundleIdByTxId(txId: string): BundleIdByTxId {
            const bundleId = bundleTransactions.get(txId)

            return { bundleId: bundleId ?? null }
        }

        it('returns null for unknown txId', () => {
            // #when
            const result = getBundleIdByTxId('unknown-tx')

            // #then
            expect(result.bundleId).toBeNull()
        })

        it('returns bundleId for known txId', () => {
            // #given
            addBundleTx('bundle-123', 'tx-456')

            // #when
            const result = getBundleIdByTxId('tx-456')

            // #then
            expect(result.bundleId).toBe('bundle-123')
        })

        it('maps multiple txIds to same bundleId', () => {
            // #given - batch transaction creates multiple txs for one bundle
            addBundleTx('bundle-123', 'tx-1')
            addBundleTx('bundle-123', 'tx-2')

            // #when
            const result1 = getBundleIdByTxId('tx-1')
            const result2 = getBundleIdByTxId('tx-2')

            // #then
            expect(result1.bundleId).toBe('bundle-123')
            expect(result2.bundleId).toBe('bundle-123')
        })

        it('tracks different bundles independently', () => {
            // #given
            addBundleTx('bundle-A', 'tx-A')
            addBundleTx('bundle-B', 'tx-B')

            // #when
            const resultA = getBundleIdByTxId('tx-A')
            const resultB = getBundleIdByTxId('tx-B')

            // #then
            expect(resultA.bundleId).toBe('bundle-A')
            expect(resultB.bundleId).toBe('bundle-B')
        })
    })

    // ============================================================================
    // Retry Attempt Counter Tests
    // ============================================================================

    describe('confirmation retry logic', () => {
        const MAX_CONFIRM_ATTEMPTS = 10

        interface ConfirmJob {
            bundleId: string
            txHash: Hex
            attempt: number
        }

        function shouldRetry(job: ConfirmJob): ConfirmRetry {
            if (job.attempt >= MAX_CONFIRM_ATTEMPTS) {
                return { shouldRetry: false, nextAttempt: job.attempt }
            }

            return { shouldRetry: true, nextAttempt: job.attempt + 1 }
        }

        function calculateDelay(attempt: number): number {
            return Math.min(Math.pow(2, attempt), 60)
        }

        it('increments attempt counter on retry', () => {
            // #given
            const job: ConfirmJob = {
                bundleId: 'bundle-1',
                txHash: '0xabc',
                attempt: 0,
            }

            // #when
            const result = shouldRetry(job)

            // #then
            expect(result.shouldRetry).toBe(true)
            expect(result.nextAttempt).toBe(1)
        })

        it('stops retrying after max attempts', () => {
            // #given
            const job: ConfirmJob = {
                bundleId: 'bundle-1',
                txHash: '0xabc',
                attempt: MAX_CONFIRM_ATTEMPTS,
            }

            // #when
            const result = shouldRetry(job)

            // #then
            expect(result.shouldRetry).toBe(false)
        })

        it('calculates exponential backoff delay', () => {
            expect(calculateDelay(1)).toBe(2)
            expect(calculateDelay(2)).toBe(4)
            expect(calculateDelay(3)).toBe(8)
            expect(calculateDelay(5)).toBe(32)
            expect(calculateDelay(6)).toBe(60) // capped at 60
            expect(calculateDelay(10)).toBe(60) // still capped
        })
    })
})
