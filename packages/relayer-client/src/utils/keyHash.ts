/**
 * Utility functions for computing key hashes
 */

import { type Address, type Hex, keccak256, encodeAbiParameters, parseAbiParameters, concat } from 'viem'

/**
 * Key types supported by Account
 *
 * Maps to Account.KeyType enum:
 * - Secp256k1 = 0: Standard Ethereum EOA keys
 * - External = 1: Delegated to an external ISigner contract
 * - P256 = 2: WebAuthn / passkey (public key is 64-byte x||y)
 */
export type KeyType = 'secp256k1' | 'external' | 'p256'

/**
 * Account.KeyType enum value.
 */
export function keyTypeToEnum(keyType: KeyType): 0 | 1 | 2 {
    if (keyType === 'secp256k1') return 0
    if (keyType === 'external') return 1
    return 2
}

/**
 * Compute the key hash for an authorized key.
 *
 * This matches Account's key hash computation:
 * `keccak256(abi.encode(uint8(keyType), keccak256(publicKey)))`
 *
 * @param keyType - The type of key ('secp256k1', 'external', or 'p256')
 * @param publicKey - The public key bytes (for secp256k1, this is abi.encode(address); for p256, x||y)
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
    const keyTypeNum = keyTypeToEnum(keyType)
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

function requireCoordinate(value: Hex, label: string): Hex {
    const hex = value.toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(hex)) {
        throw new Error(`${label} must be a 32-byte hex coordinate`)
    }
    return hex as Hex
}

/**
 * Encode a P-256 public key as the 64-byte `x || y` blob Account expects.
 */
export function encodeP256PublicKey(x: Hex, y: Hex): Hex {
    return concat([requireCoordinate(x, 'x'), requireCoordinate(y, 'y')])
}
