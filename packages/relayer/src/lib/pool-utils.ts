/**
 * Pool Utilities
 *
 * Pure functions for signer pool operations.
 * These are extracted for testability.
 */

import { keccak256, type Address } from 'viem'

/**
 * Select a signer index deterministically based on EOA address.
 *
 * Uses keccak256 hash to distribute EOAs across signers consistently.
 * This ensures that transactions for the same EOA always route to the
 * same signer, preventing nonce conflicts from concurrent requests.
 *
 * @param eoa - The EOA address to route
 * @param signerCount - Total number of signers in the pool
 * @returns The signer index (0 to signerCount-1)
 * @throws Error if signerCount is not positive
 */
export function selectSignerForEoa(eoa: Address, signerCount: number): number {
    if (signerCount <= 0) {
        throw new Error('signerCount must be positive')
    }
    if (signerCount === 1) {
        return 0
    }
    const hash = keccak256(eoa)
    return Number(BigInt(hash) % BigInt(signerCount))
}
