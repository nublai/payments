import { serializeSignature, type Address, type Hex, type Signature } from 'viem'
import type { PrepareCallsResponse } from '../actions/prepareCalls'
import { computeErc1271Digest } from '../utils/erc1271'
import { wrapSignature } from '../utils/signature'
import { bindPreparedCalls, type PreparedCallsExpectation } from './bindPreparedCalls'

type SignatureValue = Hex | Signature

export type TypedDataSignerInput = {
    type: 'typedData'
    signTypedData: (typedData: PrepareCallsResponse['typedData']) => Promise<SignatureValue>
    signerKeyHash?: Hex
    prehash?: boolean
}

export type DelegatedDigestSignerInput = {
    type: 'delegated'
    signDigest: (digest: Hex) => Promise<SignatureValue>
    signerKeyHash: Hex
    /**
     * Address of the delegated signer account used for ERC-1271 digest transformation.
     * This must be the signer contract/account address, not the target `from` account.
     */
    signerAddress?: Address
    /**
     * @deprecated Use signerAddress instead.
     */
    accountAddress?: Address
    prehash?: boolean
}

export type SignPreparedCallsSigner = TypedDataSignerInput | DelegatedDigestSignerInput

export interface SignPreparedCallsParams {
    prepared: PrepareCallsResponse
    signer: SignPreparedCallsSigner
    /** Calls, account, chain, verifying contract, nonce, and fee caps the caller agreed to. */
    expected: PreparedCallsExpectation
}

export interface SignPreparedCallsResult {
    signerType: SignPreparedCallsSigner['type']
    /** Raw signature before optional wrapSignature(...) */
    rawSignature: Hex
    /** Signature to pass to wallet_sendPreparedCalls */
    signature: Hex
    /** Digest expected to be signed by the chosen signer mode */
    digestToSign: Hex
    wrapped: boolean
}

function toSignatureHex(value: SignatureValue): Hex {
    if (typeof value === 'string') {
        return value
    }
    return serializeSignature(value)
}

/**
 * Sign prepared calls via either:
 * - EOA typed-data signing, or
 * - delegated ERC-1271 digest signing.
 *
 * Wraps the resulting signature when signerKeyHash is present/required.
 */
export async function signPreparedCalls(
    params: SignPreparedCallsParams,
): Promise<SignPreparedCallsResult> {
    const { prepared, signer, expected } = params
    bindPreparedCalls(prepared, expected)

    if (signer.type === 'typedData') {
        const rawSignature = toSignatureHex(await signer.signTypedData(prepared.typedData))
        if (signer.signerKeyHash === undefined) {
            return {
                signerType: signer.type,
                rawSignature,
                signature: rawSignature,
                digestToSign: prepared.digest,
                wrapped: false,
            }
        }

        return {
            signerType: signer.type,
            rawSignature,
            signature: wrapSignature(rawSignature, signer.signerKeyHash, signer.prehash ?? false),
            digestToSign: prepared.digest,
            wrapped: true,
        }
    }

    const signerAddress = signer.signerAddress ?? signer.accountAddress
    if (signerAddress === undefined) {
        throw new Error(
            'delegated signer requires signerAddress (or deprecated accountAddress) for ERC-1271 digest transformation',
        )
    }
    const digestToSign = computeErc1271Digest(prepared.digest, signerAddress)
    const rawSignature = toSignatureHex(await signer.signDigest(digestToSign))
    return {
        signerType: signer.type,
        rawSignature,
        signature: wrapSignature(rawSignature, signer.signerKeyHash, signer.prehash ?? false),
        digestToSign,
        wrapped: true,
    }
}
