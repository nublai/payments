import { describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import type { PrepareCallsResponse } from '../../src/actions/prepareCalls.js'
import { computeErc1271Digest } from '../../src/utils/erc1271.js'
import { wrapSignature } from '../../src/utils/signature.js'
import { signPreparedCalls } from '../../src/helpers/signPreparedCalls.js'

const RAW_SIGNATURE = `0x${'11'.repeat(65)}` as Hex
const KEY_HASH = `0x${'22'.repeat(32)}` as Hex
const TARGET_ACCOUNT = '0x1234567890123456789012345678901234567890' as Address
const DELEGATED_SIGNER = '0x9876543210987654321098765432109876543210' as Address

function makePrepared(eoa: Address = TARGET_ACCOUNT): PrepareCallsResponse {
    return {
        context: {} as PrepareCallsResponse['context'],
        digest: `0x${'33'.repeat(32)}` as Hex,
        typedData: {
            domain: {
                name: 'Relayer',
                version: '1',
                chainId: 8453,
                verifyingContract: '0x1111111111111111111111111111111111111111',
            },
            types: {
                Intent: [],
                Call: [],
            } as PrepareCallsResponse['typedData']['types'],
            primaryType: 'Intent',
            message: {
                multichain: false,
                eoa,
                calls: [],
                nonce: 1n,
                payer: eoa,
                paymentToken: '0x0000000000000000000000000000000000000000',
                paymentMaxAmount: 0n,
                combinedGas: 0n,
                encodedPreCalls: [],
                encodedFundTransfers: [],
                settler: '0x0000000000000000000000000000000000000000',
                expiry: 0n,
            },
        },
    }
}

describe('helpers/signPreparedCalls', () => {
    it('signs typed-data mode without wrapping by default', async () => {
        const prepared = makePrepared()
        const signTypedData = vi.fn(async () => RAW_SIGNATURE)

        const result = await signPreparedCalls({
            prepared,
            signer: {
                type: 'typedData',
                signTypedData,
            },
        })

        expect(signTypedData).toHaveBeenCalledWith(prepared.typedData)
        expect(result.signature).toBe(RAW_SIGNATURE)
        expect(result.rawSignature).toBe(RAW_SIGNATURE)
        expect(result.wrapped).toBe(false)
        expect(result.digestToSign).toBe(prepared.digest)
    })

    it('wraps typed-data signatures when signerKeyHash is provided', async () => {
        const prepared = makePrepared()

        const result = await signPreparedCalls({
            prepared,
            signer: {
                type: 'typedData',
                signerKeyHash: KEY_HASH,
                signTypedData: async () => RAW_SIGNATURE,
            },
        })

        expect(result.signature).toBe(wrapSignature(RAW_SIGNATURE, KEY_HASH))
        expect(result.wrapped).toBe(true)
    })

    it('computes ERC-1271 digest in delegated mode using signerAddress and wraps signature', async () => {
        const prepared = makePrepared()
        const expectedDigest = computeErc1271Digest(prepared.digest, DELEGATED_SIGNER)
        const signDigest = vi.fn(async () => RAW_SIGNATURE)

        const result = await signPreparedCalls({
            prepared,
            signer: {
                type: 'delegated',
                signerAddress: DELEGATED_SIGNER,
                signerKeyHash: KEY_HASH,
                signDigest,
            },
        })

        expect(signDigest).toHaveBeenCalledWith(expectedDigest)
        expect(result.digestToSign).toBe(expectedDigest)
        expect(result.signature).toBe(wrapSignature(RAW_SIGNATURE, KEY_HASH))
        expect(result.wrapped).toBe(true)
    })

    it('throws when delegated signer address is not provided', async () => {
        const prepared = makePrepared()
        await expect(
            signPreparedCalls({
                prepared,
                signer: {
                    type: 'delegated',
                    signerKeyHash: KEY_HASH,
                    signDigest: async () => RAW_SIGNATURE,
                },
            }),
        ).rejects.toThrow('delegated signer requires signerAddress')
    })
})
