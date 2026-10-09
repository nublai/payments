import {
    decodeAbiParameters,
    encodeAbiParameters,
    isAddress,
    keccak256,
    parseAbiParameters,
    type Address,
    type Hex,
    type PublicClient,
} from 'viem'
import { accountAbi } from '@nubl/contracts/abis'

import { getChainClient } from '../../lib/multi-chain-client'
import type { Env } from '../../types/env'

/**
 * Account key hash for a secp256k1 signer: keccak256(abi.encode(uint8(0), keccak256(abi.encode(address)))).
 */
export function secp256k1AccountKeyHash(signer: Address): Hex {
    const publicKey = encodeAbiParameters([{ type: 'address' }], [signer])

    const encoded = encodeAbiParameters(parseAbiParameters('uint8, bytes32'), [
        0,
        keccak256(publicKey),
    ])

    return keccak256(encoded)
}

/**
 * True when `signer` is a live secp256k1 key registered on `account`.
 * A missing account, a revert, or an expired key is false.
 */
export type AccountKeyClient = Pick<PublicClient, 'readContract'>

export async function isOnChainAccountKey(
    client: AccountKeyClient,
    account: Address,
    signer: Address,
    nowSeconds: number,
): Promise<boolean> {
    if (!isAddress(account) || !isAddress(signer)) return false

    try {
        const key = await client.readContract({
            address: account,
            abi: accountAbi,
            functionName: 'getKey',
            args: [secp256k1AccountKeyHash(signer)],
        })

        const expiry = BigInt(key.expiry)

        // Match Account.getKeys: expiry 0 never expires; a key is expired only after its timestamp.
        if (expiry !== 0n && BigInt(nowSeconds) > expiry) return false

        if (Number(key.keyType) !== 0) return false
        const [decoded] = decodeAbiParameters([{ type: 'address' }], key.publicKey)

        return typeof decoded === 'string' && decoded.toLowerCase() === signer.toLowerCase()
    } catch {
        return false
    }
}

export type SignerAccountKeyDeps = {
    getChainClient?: (chainId: number, env: Partial<Env>) => AccountKeyClient
}

export async function signerIsAccountKey(
    env: Partial<Env>,
    account: Address,
    chainId: number,
    signer: Address,
    nowSeconds: number,
    deps?: SignerAccountKeyDeps,
): Promise<boolean> {
    try {
        const resolveClient = deps?.getChainClient ?? getChainClient
        const client = resolveClient(chainId, env)

        return await isOnChainAccountKey(client, account, signer, nowSeconds)
    } catch {
        return false
    }
}
