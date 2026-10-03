import type { Address, Hex } from 'viem'

/**
 * Parameters for wallet_verifySignature
 */
export interface VerifySignatureParams {
    address: Address
    digest: Hex
    signature: Hex
    chain_id: string
}

/**
 * Proof of valid signature
 */
export interface ValidSignatureProof {
    account: Address
    key_hash: Hex
}

/**
 * Result of wallet_verifySignature
 */
export interface VerifySignatureResult {
    valid: boolean
    proof: ValidSignatureProof | null
}
