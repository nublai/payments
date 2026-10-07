import { describe, expect, it, vi } from 'vitest'
import { zeroAddress, type Address, type Hex } from 'viem'
import { hashTypedData } from 'viem/utils'
import type { PrepareCallsResponse } from '../../src/actions/prepareCalls.js'
import type { PreparedCallsExpectation } from '../../src/helpers/bindPreparedCalls.js'
import { signPreparedCalls } from '../../src/helpers/signPreparedCalls.js'
import { INTENT_TYPES } from '../../src/types.js'
import { computeErc1271Digest } from '../../src/utils/erc1271.js'
import { wrapSignature } from '../../src/utils/signature.js'

const RAW_SIGNATURE = `0x${'11'.repeat(65)}` as Hex
const KEY_HASH = `0x${'22'.repeat(32)}` as Hex
const TARGET_ACCOUNT = '0x1234567890123456789012345678901234567890' as Address
const DELEGATED_SIGNER = '0x9876543210987654321098765432109876543210' as Address
const ORCHESTRATOR = '0x1111111111111111111111111111111111111111' as Address

function makePrepared(eoa: Address = TARGET_ACCOUNT): PrepareCallsResponse {
    const message = {
        multichain: false,
        eoa,
        calls: [] as { to: Address; value: bigint; data: Hex }[],
        nonce: 1n,
        payer: eoa,
        paymentToken: zeroAddress,
        paymentMaxAmount: 0n,
        combinedGas: 1n,
        encodedPreCalls: [] as Hex[],
        encodedFundTransfers: [] as Hex[],
        settler: zeroAddress,
        expiry: 1_700_000_120n,
    }
    const domain = {
        name: 'Orchestrator' as const,
        version: '0.5.5' as const,
        chainId: 8453,
        verifyingContract: ORCHESTRATOR,
    }
    const digest = hashTypedData({
        domain,
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message,
    })
    return {
        context: {
            quote: {
                quotes: [
                    {
                        chainId: '0x2105',
                        orchestrator: ORCHESTRATOR,
                        intent: {
                            eoa,
                            calls: [],
                            nonce: '1',
                            combinedGas: '1',
                            expiry: '1700000120',
                            payer: eoa,
                            paymentToken: zeroAddress,
                            paymentMaxAmount: '0',
                            settler: zeroAddress,
                        },
                        extraPayment: '0x0',
                        ethPrice: '0x0',
                        paymentTokenDecimals: 6,
                        txGas: 1,
                        nativeFeeEstimate: { maxFeePerGas: 1, maxPriorityFeePerGas: 1 },
                        paymentAmount: '0',
                        feeTokenDeficit: '0x0',
                        assetDeficits: [],
                    },
                ],
                signature: '0x',
                ttl: 2_000_000_000,
            },
        },
        digest,
        typedData: {
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent',
            message,
        },
    }
}

function expectedFor(eoa: Address = TARGET_ACCOUNT): PreparedCallsExpectation {
    return {
        from: eoa,
        calls: [],
        chainId: 8453,
        verifyingContract: ORCHESTRATOR,
        nonce: 1n,
        payer: eoa,
        paymentToken: zeroAddress,
        paymentMaxAmount: 0n,
        expiry: 1_700_000_120n,
        now: 1_700_000_000n,
        combinedGasCeiling: 1_000_000n,
    }
}

describe('helpers/signPreparedCalls', () => {
    it('signs typed-data mode without wrapping by default', async () => {
        const prepared = makePrepared()
        const signTypedData = vi.fn(async () => RAW_SIGNATURE)

        const result = await signPreparedCalls({
            prepared,
            expected: expectedFor(),
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
            expected: expectedFor(),
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
            expected: expectedFor(),
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
                expected: expectedFor(),
                signer: {
                    type: 'delegated',
                    signerKeyHash: KEY_HASH,
                    signDigest: async () => RAW_SIGNATURE,
                },
            }),
        ).rejects.toThrow('delegated signer requires signerAddress')
    })
})
