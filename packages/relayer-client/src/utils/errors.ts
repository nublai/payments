/**
 * Intent error decoding utilities
 *
 * Maps bytes4 error selectors to human-readable names.
 */

import type { Hex } from 'viem'

/**
 * Known intent error selectors from the Orchestrator and Account contracts
 */
export const INTENT_ERRORS = {
    // Orchestrator errors
    '0x6c9d47e8': 'CallError',
    '0x9b7d7f5e': 'InsufficientGas',
    '0x54e8e567': 'IntentExpired',
    '0xc0c5e7f3': 'InvalidPreCallEOA',
    '0x5a4e5e7a': 'OrderAlreadyFilled',
    '0x4e487b71': 'PaymentError',
    '0x2228d5db': 'PreCallError',
    '0x5a392a87': 'PreCallVerificationError',
    '0xab143c06': 'Reentrancy',
    '0x78210001': 'SimulateExecuteFailed',
    '0x5c6e7f5e': 'StateOverrideError',
    '0x4a586736': 'UnauthorizedCallContext',
    '0x7a5e7f5e': 'UnsupportedAccountImplementation',
    '0x8baa579f': 'VerificationError',
    '0x9c5e7f5e': 'VerifiedCallError',

    // GuardedExecutor errors (Account)
    '0x9054c912': 'ExceededSpendLimit',
    '0x82b42900': 'Unauthorized',
    '0x3d693ada': 'InvalidExecutor',
    '0x6d5769be': 'InvalidKeyHash',

    // Common ERC20 errors
    '0xfb8f41b2': 'InsufficientBalance',
    '0x13be252b': 'InsufficientAllowance',
} as const

export type IntentErrorName = (typeof INTENT_ERRORS)[keyof typeof INTENT_ERRORS]

/**
 * Decode an intent error selector to a human-readable name
 *
 * @param selector - The 4-byte error selector (e.g., '0x9054c912')
 * @returns The error name or undefined if unknown
 *
 * @example
 * ```typescript
 * const status = await client.getBundleStatus({ bundleId })
 * if (status.receipt?.intentError) {
 *   const errorName = decodeIntentError(status.receipt.intentError)
 *   console.log('Intent failed:', errorName) // 'ExceededSpendLimit'
 * }
 * ```
 */
export function decodeIntentError(selector: Hex): IntentErrorName | undefined {
    const normalized = selector.toLowerCase() as keyof typeof INTENT_ERRORS

    return INTENT_ERRORS[normalized]
}

/**
 * Check if an error selector represents a known intent error
 */
export function isKnownIntentError(selector: Hex): boolean {
    return decodeIntentError(selector) !== undefined
}
