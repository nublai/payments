export interface ReplacementFeeTriggerInput {
    requiredMaxFeePerGas: bigint
    currentMaxFeePerGas: bigint
    staleThresholdPerGas: bigint
}

export interface ReplacementFeeComputationInput {
    currentMaxFeePerGas: bigint
    currentMaxPriorityFeePerGas: bigint
    requiredMaxFeePerGas: bigint
    requiredMaxPriorityFeePerGas: bigint
    bumpBps: number
    maxFeePerGasCap?: bigint
}

export interface ReplacementFeeComputationResult {
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
}

export interface FinalizationDecisionInput {
    activeTxHash: string
    eventTxHash?: string
    status: 'confirmed' | 'failed'
}

export interface ReplacementAttemptTimingInput {
    nowMs: number
    attempts: number
    maxAttempts: number
    lastReplacementAtMs: number
    baseBackoffMs: number
}

export interface NonTriggeredReplacementResolution {
    nextAttempts: number
    status: 'pending' | 'stuck'
}

function ceilMultiplyByBps(value: bigint, bps: number): bigint {
    if (bps < 0) {
        throw new Error('bumpBps must be non-negative')
    }

    const multiplier = BigInt(10_000 + bps)
    const numerator = value * multiplier

    // ceil(value * multiplier / 10_000)
    return (numerator + 9_999n) / 10_000n
}

export function mapStoredTxStatusToPublicStatus(
    storedStatus: string,
): 'pending' | 'confirmed' | 'failed' {
    if (storedStatus === 'confirmed') return 'confirmed'

    if (storedStatus === 'failed' || storedStatus === 'stuck' || storedStatus === 'abandoned') {
        return 'failed'
    }

    return 'pending'
}

export function shouldTriggerReplacementByFee(input: ReplacementFeeTriggerInput): boolean {
    return input.requiredMaxFeePerGas > input.currentMaxFeePerGas + input.staleThresholdPerGas
}

export function computeReplacementFees(
    input: ReplacementFeeComputationInput,
): ReplacementFeeComputationResult | null {
    const bumpedMaxFee = ceilMultiplyByBps(input.currentMaxFeePerGas, input.bumpBps)
    const bumpedMaxPriorityFee = ceilMultiplyByBps(input.currentMaxPriorityFeePerGas, input.bumpBps)

    const maxFeePerGas =
        bumpedMaxFee > input.requiredMaxFeePerGas ? bumpedMaxFee : input.requiredMaxFeePerGas

    const maxPriorityFeePerGas =
        bumpedMaxPriorityFee > input.requiredMaxPriorityFeePerGas
            ? bumpedMaxPriorityFee
            : input.requiredMaxPriorityFeePerGas

    if (
        input.maxFeePerGasCap !== undefined &&
        (maxFeePerGas > input.maxFeePerGasCap || maxPriorityFeePerGas > input.maxFeePerGasCap)
    ) {
        return null
    }

    return {
        maxFeePerGas,
        maxPriorityFeePerGas,
    }
}

export function shouldApplyFinalization(input: FinalizationDecisionInput): boolean {
    if (!input.eventTxHash) return true

    if (input.status === 'confirmed') return true

    return input.activeTxHash.toLowerCase() === input.eventTxHash.toLowerCase()
}

export function shouldAttemptReplacementNow(input: ReplacementAttemptTimingInput): boolean {
    if (input.maxAttempts <= 0) return false

    if (input.attempts >= input.maxAttempts) return false

    if (input.attempts === 0) return true

    const exponent = input.attempts - 1
    const backoffMs = input.baseBackoffMs * Math.pow(2, exponent)

    return input.nowMs >= input.lastReplacementAtMs + backoffMs
}

export function resolveNonTriggeredReplacement(
    attempts: number,
    maxAttempts: number,
): NonTriggeredReplacementResolution {
    const nextAttempts = attempts + 1

    return {
        nextAttempts,
        status: nextAttempts >= maxAttempts ? 'stuck' : 'pending',
    }
}

export async function withCleanupOnError<T>(
    operation: () => Promise<T>,
    cleanup: () => Promise<void> | void,
): Promise<T> {
    try {
        return await operation()
    } catch (error) {
        await cleanup()
        throw error
    }
}

export async function withRecoveryOnError<T>(
    operation: () => Promise<T>,
    recovery: () => Promise<void> | void,
    fallback: T,
): Promise<T> {
    try {
        return await operation()
    } catch {
        await recovery()

        return fallback
    }
}
