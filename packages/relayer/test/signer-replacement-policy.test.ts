import { describe, expect, it } from 'vitest'
import {
    mapStoredTxStatusToPublicStatus,
    shouldTriggerReplacementByFee,
    computeReplacementFees,
    shouldApplyFinalization,
    shouldAttemptReplacementNow,
    resolveNonTriggeredReplacement,
    withCleanupOnError,
    withRecoveryOnError,
} from '../src/durable-objects/signer-replacement-policy'

describe('replacement policy', () => {
    describe('status mapping', () => {
        it('maps replacing to pending', () => {
            expect(mapStoredTxStatusToPublicStatus('replacing')).toBe('pending')
        })

        it('maps abandoned to failed', () => {
            expect(mapStoredTxStatusToPublicStatus('abandoned')).toBe('failed')
        })
    })

    describe('shouldTriggerReplacementByFee', () => {
        it('returns false when required fee does not exceed current + threshold', () => {
            const trigger = shouldTriggerReplacementByFee({
                requiredMaxFeePerGas: 110n,
                currentMaxFeePerGas: 100n,
                staleThresholdPerGas: 10n,
            })

            expect(trigger).toBe(false)
        })

        it('returns true when required fee exceeds current + threshold', () => {
            const trigger = shouldTriggerReplacementByFee({
                requiredMaxFeePerGas: 111n,
                currentMaxFeePerGas: 100n,
                staleThresholdPerGas: 10n,
            })

            expect(trigger).toBe(true)
        })
    })

    describe('computeReplacementFees', () => {
        it('bumps both fee fields by 12.5% and rounds up', () => {
            const next = computeReplacementFees({
                currentMaxFeePerGas: 100n,
                currentMaxPriorityFeePerGas: 80n,
                requiredMaxFeePerGas: 90n,
                requiredMaxPriorityFeePerGas: 70n,
                bumpBps: 1250,
            })

            expect(next).toEqual({
                maxFeePerGas: 113n,
                maxPriorityFeePerGas: 90n,
            })
        })

        it('never drops below required market fee', () => {
            const next = computeReplacementFees({
                currentMaxFeePerGas: 100n,
                currentMaxPriorityFeePerGas: 80n,
                requiredMaxFeePerGas: 200n,
                requiredMaxPriorityFeePerGas: 150n,
                bumpBps: 1250,
            })

            expect(next).toEqual({
                maxFeePerGas: 200n,
                maxPriorityFeePerGas: 150n,
            })
        })

        it('returns null when computed max fee exceeds fee cap', () => {
            const next = computeReplacementFees({
                currentMaxFeePerGas: 100n,
                currentMaxPriorityFeePerGas: 80n,
                requiredMaxFeePerGas: 500n,
                requiredMaxPriorityFeePerGas: 150n,
                bumpBps: 1250,
                maxFeePerGasCap: 300n,
            })

            expect(next).toBeNull()
        })
    })

    describe('shouldApplyFinalization', () => {
        it('applies confirmation from superseded hash to close parent tx', () => {
            expect(
                shouldApplyFinalization({
                    activeTxHash: '0xnew',
                    eventTxHash: '0xold',
                    status: 'confirmed',
                }),
            ).toBe(true)
        })

        it('ignores failed finalization from superseded hash', () => {
            expect(
                shouldApplyFinalization({
                    activeTxHash: '0xnew',
                    eventTxHash: '0xold',
                    status: 'failed',
                }),
            ).toBe(false)
        })

        it('applies failed finalization when hash matches active', () => {
            expect(
                shouldApplyFinalization({
                    activeTxHash: '0xsame',
                    eventTxHash: '0xsame',
                    status: 'failed',
                }),
            ).toBe(true)
        })
    })

    describe('shouldAttemptReplacementNow', () => {
        it('returns false when replacement attempts are exhausted', () => {
            expect(
                shouldAttemptReplacementNow({
                    nowMs: 1_000,
                    attempts: 3,
                    maxAttempts: 3,
                    lastReplacementAtMs: 0,
                    baseBackoffMs: 30_000,
                }),
            ).toBe(false)
        })

        it('allows first replacement attempt immediately', () => {
            expect(
                shouldAttemptReplacementNow({
                    nowMs: 1_000,
                    attempts: 0,
                    maxAttempts: 3,
                    lastReplacementAtMs: 0,
                    baseBackoffMs: 30_000,
                }),
            ).toBe(true)
        })

        it('applies exponential backoff for retry attempts', () => {
            expect(
                shouldAttemptReplacementNow({
                    nowMs: 15_000,
                    attempts: 1,
                    maxAttempts: 3,
                    lastReplacementAtMs: 0,
                    baseBackoffMs: 30_000,
                }),
            ).toBe(false)

            expect(
                shouldAttemptReplacementNow({
                    nowMs: 30_000,
                    attempts: 1,
                    maxAttempts: 3,
                    lastReplacementAtMs: 0,
                    baseBackoffMs: 30_000,
                }),
            ).toBe(true)

            expect(
                shouldAttemptReplacementNow({
                    nowMs: 59_999,
                    attempts: 2,
                    maxAttempts: 3,
                    lastReplacementAtMs: 0,
                    baseBackoffMs: 30_000,
                }),
            ).toBe(false)

            expect(
                shouldAttemptReplacementNow({
                    nowMs: 60_000,
                    attempts: 2,
                    maxAttempts: 3,
                    lastReplacementAtMs: 0,
                    baseBackoffMs: 30_000,
                }),
            ).toBe(true)
        })
    })

    describe('resolveNonTriggeredReplacement', () => {
        it('keeps transaction pending while retries remain', () => {
            const resolution = resolveNonTriggeredReplacement(1, 3)

            expect(resolution).toEqual({
                nextAttempts: 2,
                status: 'pending',
            })
        })

        it('marks transaction stuck when retries are exhausted', () => {
            const resolution = resolveNonTriggeredReplacement(2, 3)

            expect(resolution).toEqual({
                nextAttempts: 3,
                status: 'stuck',
            })
        })
    })

    describe('withCleanupOnError', () => {
        it('runs cleanup and rethrows when operation fails', async () => {
            const calls: string[] = []
            const failure = new Error('boom')

            await expect(
                withCleanupOnError(
                    async () => {
                        calls.push('run')
                        throw failure
                    },
                    async () => {
                        calls.push('cleanup')
                    },
                ),
            ).rejects.toThrow('boom')

            expect(calls).toEqual(['run', 'cleanup'])
        })
    })

    describe('withRecoveryOnError', () => {
        it('runs recovery and returns fallback when operation fails', async () => {
            const calls: string[] = []

            const result = await withRecoveryOnError(
                async () => {
                    calls.push('run')
                    throw new Error('rpc down')
                },
                async () => {
                    calls.push('recover')
                },
                'skipped' as const,
            )

            expect(result).toBe('skipped')
            expect(calls).toEqual(['run', 'recover'])
        })
    })
})
