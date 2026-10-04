/**
 * Verify a signature for a delegated account
 */

import type { Address, Hex } from 'viem'
import type { RelayerPublicClient } from '../types'
import { createRelayerTransport } from '../transport'
import type {
    RpcValidSignatureProof,
    RpcVerifySignatureParams,
    RpcVerifySignatureResult,
} from '../rpc-schema'

export interface VerifySignatureParams extends Omit<RpcVerifySignatureParams, 'chain_id'> {
    /** The address of the delegated account */
    address: Address
    /** The original digest that was signed (before ERC-1271 transformation) */
    digest: Hex
    /** The signature to verify */
    signature: Hex
    /** Optional chain ID (defaults to client's chain) */
    chainId?: number
}

/**
 * Proof that a signature is valid
 */
export interface SignatureProof extends Omit<RpcValidSignatureProof, 'key_hash'> {
    keyHash: Hex
}

/**
 * Response from verifySignature
 */
export interface VerifySignatureResponse {
    /** Whether the signature is valid */
    valid: boolean
    /** Proof of validity (when valid=true) */
    proof: SignatureProof | null
}

/**
 * Verify a signature for a delegated account
 *
 * Uses JSON-RPC `wallet_verifySignature` method.
 *
 * Checks if the signature was created by an authorized admin key for the account.
 * The signature must be over the ERC-1271 transformed digest (use computeErc1271Digest).
 *
 * @example
 * ```typescript
 * import { computeErc1271Digest, keccak256 } from '@nubl/relayer-client'
 * import { sign, serializeSignature } from 'viem/accounts'
 *
 * // Sign the ERC-1271 transformed digest
 * const originalDigest = keccak256(message)
 * const erc1271Digest = computeErc1271Digest(originalDigest, accountAddress)
 * const signatureObj = await sign({ hash: erc1271Digest, privateKey: signerKey })
 * const signature = serializeSignature(signatureObj)
 *
 * // Verify
 * const result = await client.verifySignature({
 *   address: accountAddress,
 *   digest: originalDigest, // Pass the ORIGINAL digest
 *   signature
 * })
 *
 * if (result.valid) {
 *   console.log('Signed by key:', result.proof.keyHash)
 * }
 * ```
 */
export async function verifySignature(
    client: RelayerPublicClient,
    params: VerifySignatureParams,
): Promise<VerifySignatureResponse> {
    const transport = createRelayerTransport(client)

    const chainId = params.chainId ?? client.relayerConfig.chainId ?? client.chain?.id ?? 1
    const hexChainId = `0x${chainId.toString(16)}`

    const result = await transport.request<RpcVerifySignatureResult>('wallet_verifySignature', {
        address: params.address,
        digest: params.digest,
        signature: params.signature,
        chain_id: hexChainId,
    })

    return {
        valid: result.valid,
        proof: result.proof
            ? {
                  account: result.proof.account,
                  keyHash: result.proof.key_hash,
              }
            : null,
    }
}
