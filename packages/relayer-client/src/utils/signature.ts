/**
 * Signature Utilities
 *
 * Utilities for wrapping signatures for Account validation.
 */

import type { Hex } from 'viem'
import { concat, encodeAbiParameters, parseAbiParameters } from 'viem'

/**
 * Wrap a signature with keyHash and prehash flag for Account validation
 *
 * This is the format expected by Account.unwrapAndValidateSignature:
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
 * import { wrapSignature, computeKeyHash } from '@nubl/relayer-client'
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

/**
 * ABI-encode a WebAuthn assertion the way Account._validateP256Signature decodes it:
 * `abi.encode(bytes authenticatorData, bytes clientDataJSON, uint256 r, uint256 s)`.
 */
export function encodeP256InnerSignature(params: {
    authenticatorData: Hex
    clientDataJSON: Hex
    r: bigint
    s: bigint
}): Hex {
    return encodeAbiParameters(parseAbiParameters('bytes, bytes, uint256, uint256'), [
        params.authenticatorData,
        params.clientDataJSON,
        params.r,
        params.s,
    ])
}

/**
 * Wrap a P-256 WebAuthn assertion for Account.unwrapAndValidateSignature.
 *
 * Layout matches secp256k1 wrapping: `abi.encodePacked(inner, bytes32 keyHash, uint8 prehash)`.
 * `keyHash` is `computeKeyHash('p256', x || y)`. When `prehash` is set, the contract
 * sha256s the digest before checking the clientDataJSON challenge.
 */
export function encodeP256Signature(params: {
    authenticatorData: Hex
    clientDataJSON: Hex
    r: bigint
    s: bigint
    keyHash: Hex
    prehash?: boolean
}): Hex {
    return wrapSignature(
        encodeP256InnerSignature(params),
        params.keyHash,
        params.prehash ?? false,
    )
}
