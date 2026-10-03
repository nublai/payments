/**
 * Utility functions for computing key hashes
 */

import { type Address, type Hex, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem'

/**
 * Key types supported by Account
 *
 * Maps to Account.KeyType enum:
 * - Secp256k1 = 0: Standard Ethereum EOA keys
 * - External = 1: Delegated to an external ISigner contract
 */
export type KeyType = 'secp256k1' | 'external'

/**
 * Compute the key hash for an authorized key.
 *
 * This matches Account's key hash computation:
 * `keccak256(abi.encode(uint8(keyType), keccak256(publicKey)))`
 *
 * @param keyType - The type of key ('secp256k1' or 'external')
 * @param publicKey - The public key bytes (for secp256k1, this is abi.encode(address))
 * @returns The key hash
 *
 * @example
 * ```typescript
 * // For a secp256k1 key
 * const publicKey = encodeAbiParameters(
 *   [{ type: 'address' }],
 *   [signerAddress]
 * )
 * const keyHash = computeKeyHash('secp256k1', publicKey)
 * ```
 */
export function computeKeyHash(keyType: KeyType, publicKey: Hex): Hex {
    const keyTypeNum = keyType === 'secp256k1' ? 0 : 1
    const publicKeyHash = keccak256(publicKey)
    const encoded = encodeAbiParameters(parseAbiParameters('uint8, bytes32'), [
        keyTypeNum,
        publicKeyHash,
    ])
    return keccak256(encoded)
}

/**
 * Encode an address as a secp256k1 public key for Account.
 *
 * For secp256k1 keys, the "public key" is just the address ABI-encoded.
 * This is a convenience wrapper for the common pattern.
 *
 * @param address - The signer's address
 * @returns The encoded public key
 *
 * @example
 * ```typescript
 * const publicKey = encodeSecp256k1Key(signerAddress)
 * const keyHash = computeKeyHash('secp256k1', publicKey)
 * ```
 */
export function encodeSecp256k1Key(address: Address): Hex {
    return encodeAbiParameters([{ type: 'address' }], [address])
}
