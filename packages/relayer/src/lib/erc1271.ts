import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'

/**
 * ERC-1271 SIGN_TYPEHASH from Account
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
 * Compute ERC-1271 replay-safe digest.
 */
export function computeErc1271Digest(originalDigest: Hex, accountAddress: Address): Hex {
    const structHash = keccak256(
        encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'bytes32' }],
            [ERC1271_SIGN_TYPEHASH, originalDigest],
        ),
    )

    const domainSeparator = keccak256(
        encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'address' }],
            [DOMAIN_TYPEHASH_ONLY_VERIFYING_CONTRACT, accountAddress],
        ),
    )

    return keccak256(concat(['0x1901', domainSeparator, structHash]))
}

/**
 * Wrap a signature with keyHash and prehash flag for Account.
 */
export function wrapSignature(innerSignature: Hex, keyHash: Hex, prehash: boolean = false): Hex {
    const prehashByte = prehash ? '0x01' : '0x00'

    return concat([innerSignature, keyHash, prehashByte as Hex])
}
