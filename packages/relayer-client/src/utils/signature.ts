/**
 * Signature Utilities
 *
 * Utilities for wrapping signatures for TownsAccount validation.
 */

import type { Hex } from 'viem'
import { concat } from 'viem'

/**
 * Wrap a signature with keyHash and prehash flag for TownsAccount validation
 *
 * This is the format expected by TownsAccount.unwrapAndValidateSignature:
 * [signature (65 bytes)][keyHash (32 bytes)][prehash flag (1 byte)]
 *
 * The keyHash tells the contract which authorized key signed, so it can look up permissions.
 *
 * @param signature - The raw signature (65 bytes)
 * @param keyHash - The key hash identifying the authorized key
 * @param prehash - Whether the digest was prehashed (default: false)
 *
 * @example
 * ```typescript
 * import { wrapSignature, computeKeyHash } from '@towns-labs/relayer-client'
 *
 * // Sign the typed data
 * const signature = await walletClient.signTypedData(prepared.typedData)
 *
 * // Wrap for authorized key validation
 * const wrapped = wrapSignature(signature, keyHash)
 *
 * // Submit with wrapped signature
 * await client.sendPreparedCalls({ context, signature: wrapped })
 * ```
 */
export function wrapSignature(signature: Hex, keyHash: Hex, prehash: boolean = false): Hex {
    const prehashFlag = prehash ? '0x01' : '0x00'
    return concat([signature, keyHash, prehashFlag as Hex])
}
