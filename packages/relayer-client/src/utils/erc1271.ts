/**
 * ERC-1271 Signature Utilities
 *
 * Utilities for computing ERC-1271 replay-safe digests compatible with TownsAccount.
 * These match the implementation in TownsAccount._hashTypedDataOnlyVerifyingContract()
 */

import { keccak256, concat, encodeAbiParameters, type Address, type Hex } from 'viem'

/**
 * ERC-1271 SIGN_TYPEHASH from TownsAccount
 * keccak256("ERC1271Sign(bytes32 digest)")
 */
export const ERC1271_SIGN_TYPEHASH = keccak256(
    new TextEncoder().encode('ERC1271Sign(bytes32 digest)'),
) as Hex

/**
 * Domain typehash with only verifyingContract
 * keccak256("EIP712Domain(address verifyingContract)")
 */
export const DOMAIN_TYPEHASH_ONLY_VERIFYING_CONTRACT = keccak256(
    new TextEncoder().encode('EIP712Domain(address verifyingContract)'),
) as Hex

/**
 * Compute ERC-1271 replay-safe digest
 *
 * This matches TownsAccount._hashTypedDataOnlyVerifyingContract()
 * The domain separator uses only verifyingContract (no name, version, chainId).
 *
 * When signing for wallet_verifySignature, you must sign the digest returned
 * by this function, NOT the original digest.
 *
 * @param originalDigest - The original message digest (32 bytes)
 * @param accountAddress - The TownsAccount address (used as verifyingContract)
 * @returns The ERC-1271 transformed digest to sign
 *
 * @example
 * ```typescript
 * import { computeErc1271Digest } from '@towns-labs/relayer-client'
 * import { keccak256 } from 'viem'
 * import { sign } from 'viem/accounts'
 *
 * const originalDigest = keccak256(new TextEncoder().encode('message'))
 * const erc1271Digest = computeErc1271Digest(originalDigest, accountAddress)
 * const signature = await sign({ hash: erc1271Digest, privateKey: signerKey })
 * ```
 */
export function computeErc1271Digest(originalDigest: Hex, accountAddress: Address): Hex {
    // structHash = keccak256(abi.encode(SIGN_TYPEHASH, originalDigest))
    const structHash = keccak256(
        encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'bytes32' }],
            [ERC1271_SIGN_TYPEHASH, originalDigest],
        ),
    )

    // domainSeparator = keccak256(abi.encode(DOMAIN_TYPEHASH, address(this)))
    const domainSeparator = keccak256(
        encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'address' }],
            [DOMAIN_TYPEHASH_ONLY_VERIFYING_CONTRACT, accountAddress],
        ),
    )

    // digest = keccak256("\x19\x01" || domainSeparator || structHash)
    return keccak256(concat(['0x1901', domainSeparator, structHash]))
}
