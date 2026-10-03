import { encodeAbiParameters, encodePacked, keccak256, stringToHex, type Hex } from 'viem'
import { Address } from '../types/ContractTypes'

/**
 * https://github.com/ethereum/EIPs/blob/master/EIPS/eip-712.md
 * */
interface LinkedWalletValue {
    message: string
    userID: Address
    nonce: bigint
}

interface TypedDataField {
    name: string
    type: string
}

interface TypedDataDomain {
    name?: string
    version?: string
    chainId?: number | bigint
    verifyingContract?: Address
}

interface Eip712LinkedWalletArgs {
    domain: TypedDataDomain
    nonce: bigint
    userID: Address
    message: string
}

export function createEip712LinkedWalletdData({
    domain,
    userID,
    nonce,
    message,
}: Eip712LinkedWalletArgs) {
    // should match the types and order of _LINKED_WALLET_TYPEHASH in
    // river/contracts/src/factory/facets/wallet-link/WalletLinkBase.sol
    const linkedWalletTypes: Record<string, TypedDataField[]> = {
        LinkedWallet: [
            { name: 'message', type: 'string' },
            { name: 'userID', type: 'address' },
            { name: 'nonce', type: 'uint256' },
        ],
    }
    const types = linkedWalletTypes
    const value: LinkedWalletValue = {
        message,
        userID,
        nonce,
    }
    return {
        types,
        domain,
        value,
    }
}

export function getDomainSeparator(domain: TypedDataDomain): Hex {
    // this hash should match _TYPE_HASH
    // in river/contracts/src/diamond/utils/cryptography/signature/EIP712Base.sol
    const DOMAIN_TYPE_HASH = keccak256(
        stringToHex(
            'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
        ),
    )
    // Compute the keccak256 hash of the name and version
    const nameHash = keccak256(stringToHex(domain.name ?? ''))
    const versionHash = keccak256(stringToHex(domain.version ?? ''))
    // Encode the data
    const encodedData = encodeAbiParameters(
        [
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'address' },
        ],
        [
            DOMAIN_TYPE_HASH,
            nameHash,
            versionHash,
            BigInt(domain.chainId ?? 0),
            domain.verifyingContract ?? '0x0000000000000000000000000000000000000000',
        ],
    )

    // Compute the keccak256 hash of the encoded data
    return keccak256(encodedData)
}

export function toLinkedWalletHash(message: string, address: string, nonce: bigint): Hex {
    // this hash should match _LINKED_WALLET_TYPEHASH in
    // river/contracts/src/factory/facets/wallet-link/WalletLinkBase.sol
    const LINKED_WALLET_TYPE_HASH = keccak256(
        stringToHex('LinkedWallet(string message,address userID,uint256 nonce)'),
    )
    const structHash = keccak256(
        encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'string' }, { type: 'address' }, { type: 'uint256' }],
            [LINKED_WALLET_TYPE_HASH, message, address as Address, nonce],
        ),
    )
    return structHash
}

/**
 * @dev Returns the keccak256 digest of an EIP-712 typed data (EIP-191 version `0x01`).
 *
 * The digest is calculated from a `domainSeparator` and a `structHash`, by prefixing them with
 * `0x1901` and hashing the result. It corresponds to the hash signed by the
 * https://eips.ethereum.org/EIPS/eip-712[`eth_signTypedData`] JSON-RPC method as part of EIP-712.
 *
 * See {ECDSA-recover}.
 */
export function toTypedDataHash(domain: TypedDataDomain, structHash: Hex): Hex {
    const domainSeparator = getDomainSeparator(domain)
    const encodedData = encodePacked(
        ['bytes2', 'bytes32', 'bytes32'],
        ['0x1901', domainSeparator, structHash],
    )
    return keccak256(encodedData)
}
