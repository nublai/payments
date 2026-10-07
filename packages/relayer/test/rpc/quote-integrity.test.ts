import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'

import { signQuotes } from '../../src/lib/quote-signing'
import {
    INVALID_PARAMS,
    INVALID_QUOTE_SIGNATURE,
    INVALID_SIGNATURE,
    PAYMENT_EXCEEDS_MAX,
    RpcError,
} from '../../src/rpc/errors'
import {
    assertErc8128BoundToQuotes,
    buildIntentFromParams,
    validateQuote,
} from '../../src/rpc/methods/shared/calls-helpers'
import type { Quote, SignedQuotes } from '../../src/rpc/schema/prepareCalls'
import type { SendPreparedCallsParams } from '../../src/rpc/schema/sendPreparedCalls'
import { convertToFeeToken } from '../../src/services/fees'

const PAYER = '0x4444444444444444444444444444444444444444' as Address
const EOA = '0x1111111111111111111111111111111111111111' as Address
const ORCHESTRATOR = '0x3456789012345678901234567890123456789012' as Address
const FEE_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

function makeQuote(overrides?: {
    paymentAmount?: string
    paymentMaxAmount?: string
    txGas?: number
    maxFeePerGas?: number
    paymentToken?: Address
    paymentTokenDecimals?: number
    nativeRate?: string
}): Quote {
    return {
        chainId: '0x2105',
        intent: {
            eoa: EOA,
            calls: [],
            nonce: '1',
            combinedGas: '1',
            expiry: '1',
            payer: PAYER,
            paymentToken: overrides?.paymentToken,
            paymentMaxAmount: overrides?.paymentMaxAmount ?? '1000000',
        },
        extraPayment: '0x0',
        ethPrice: '0x0',
        paymentTokenDecimals: overrides?.paymentTokenDecimals ?? 18,
        txGas: overrides?.txGas ?? 1000,
        nativeFeeEstimate: {
            maxFeePerGas: overrides?.maxFeePerGas ?? 100,
            maxPriorityFeePerGas: 1,
        },
        paymentAmount: overrides?.paymentAmount ?? '0',
        nativeRate: overrides?.nativeRate,
        orchestrator: ORCHESTRATOR,
        feeTokenDeficit: '0x0',
        assetDeficits: [],
    }
}

function makeSigned(quote: Quote, ttl: number, signature: Hex = '0x'): SignedQuotes {
    return { quotes: [quote], signature, ttl }
}

function makeParams(quote: Quote, ttl: number, signature: Hex = '0x'): SendPreparedCallsParams {
    return {
        context: { quote: makeSigned(quote, ttl, signature) },
        signature: `0x${'ab'.repeat(65)}`,
    }
}

describe('quote payment integrity', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('rejects an unsigned zero-fee quote outside local', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
        const ttl = Math.floor(Date.now() / 1000) + 60
        const quote = makeQuote({
            paymentAmount: '0',
            paymentMaxAmount: '1000000',
        })

        const result = await validateQuote(makeSigned(quote, ttl, '0x'), {})

        expect(result).toBeInstanceOf(RpcError)
        expect((result as RpcError).code).toBe(INVALID_QUOTE_SIGNATURE)
    })

    it('collects the recomputed fee instead of a client paymentAmount of 0', () => {
        const ttl = Math.floor(Date.now() / 1000) + 60
        const quote = makeQuote({
            paymentAmount: '0',
            paymentMaxAmount: '1000000',
            txGas: 1000,
            maxFeePerGas: 100,
        })

        const intent = buildIntentFromParams(makeParams(quote, ttl))

        expect(intent.payer?.toLowerCase()).toBe(PAYER.toLowerCase())
        expect(intent.paymentMaxAmount).toBe('1000000')
        expect(intent.paymentAmount).toBe('100000')
    })

    it('rejects a zero client payment when the recomputed fee exceeds the max', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
        const ttl = Math.floor(Date.now() / 1000) + 60
        const quote = makeQuote({
            paymentAmount: '0',
            paymentMaxAmount: '1',
            txGas: 1000,
            maxFeePerGas: 100,
        })

        const result = await validateQuote(makeSigned(quote, ttl), {
            CONTEXT: 'local',
        })

        expect(result).toBeInstanceOf(RpcError)
        expect((result as RpcError).code).toBe(PAYMENT_EXCEEDS_MAX)
        expect((result as RpcError).message).toContain('100000')
    })

    it('recomputes an ERC-20 fee from nativeRate and ignores paymentAmount 0', () => {
        const ttl = Math.floor(Date.now() / 1000) + 60
        const nativeRate = 3000n * 10n ** 18n
        const expected = convertToFeeToken(21_000n * 1_000_000_000n, nativeRate, 6)
        const quote = makeQuote({
            paymentAmount: '0',
            paymentMaxAmount: (expected + 1n).toString(),
            txGas: 21_000,
            maxFeePerGas: 1_000_000_000,
            paymentToken: FEE_TOKEN,
            paymentTokenDecimals: 6,
            nativeRate: nativeRate.toString(),
        })

        const intent = buildIntentFromParams(makeParams(quote, ttl))

        expect(expected > 0n).toBe(true)
        expect(intent.paymentAmount).toBe(expected.toString())
    })

    it('rejects a fee-token quote that omits nativeRate', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
        const ttl = Math.floor(Date.now() / 1000) + 60
        const quote = makeQuote({
            paymentAmount: '0',
            paymentToken: FEE_TOKEN,
            paymentTokenDecimals: 6,
        })

        const result = await validateQuote(makeSigned(quote, ttl), {
            CONTEXT: 'local',
        })

        expect(result).toBeInstanceOf(RpcError)
        expect((result as RpcError).code).toBe(INVALID_PARAMS)
    })

    it('still recomputes the fee when a signed quote claims paymentAmount 0', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
        const ttl = Math.floor(Date.now() / 1000) + 60
        const secret = 'test-quote-signing-secret'
        const quote = makeQuote({
            paymentAmount: '0',
            txGas: 1000,
            maxFeePerGas: 100,
        })
        const signed = makeSigned(quote, ttl, '0x')
        signed.signature = await signQuotes(signed, secret)

        const result = await validateQuote(signed, {
            CONTEXT: 'prod',
            QUOTE_SIGNING_SECRET: secret,
        })
        const intent = buildIntentFromParams(makeParams(quote, ttl, signed.signature))

        expect(result).toBeNull()
        expect(intent.paymentAmount).toBe('100000')
    })

    it('rejects a signed quote whose paymentAmount was rewritten', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
        const ttl = Math.floor(Date.now() / 1000) + 60
        const secret = 'test-quote-signing-secret'
        const signed = makeSigned(makeQuote({ paymentAmount: '100000' }), ttl, '0x')
        signed.signature = await signQuotes(signed, secret)
        signed.quotes[0].paymentAmount = '0'

        const result = await validateQuote(signed, {
            CONTEXT: 'prod',
            QUOTE_SIGNING_SECRET: secret,
        })

        expect(result).toBeInstanceOf(RpcError)
        expect((result as RpcError).code).toBe(INVALID_QUOTE_SIGNATURE)
    })

    it('rejects a signed payer quote whose recomputed fee is zero outside local', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
        const ttl = Math.floor(Date.now() / 1000) + 60
        const secret = 'test-quote-signing-secret'
        const quote = makeQuote({
            paymentAmount: '0',
            paymentMaxAmount: '1000000',
            txGas: 21_000,
            maxFeePerGas: 0,
        })
        const signed = makeSigned(quote, ttl, '0x')
        signed.signature = await signQuotes(signed, secret)

        const result = await validateQuote(signed, {
            CONTEXT: 'prod',
            QUOTE_SIGNING_SECRET: secret,
        })

        expect(result).toBeInstanceOf(RpcError)
        expect((result as RpcError).code).toBe(INVALID_PARAMS)
        expect((result as RpcError).message).toContain('zero fee')
    })

    it('rejects an ERC-8128 caller that only matches a client authSigner', async () => {
        const result = await assertErc8128BoundToQuotes(
            { CONTEXT: 'prod' },
            {
                provider: 'erc8128',
                userId: '0x9999999999999999999999999999999999999999',
            },
            [
                {
                    chainId: '0x2105',
                    intent: { eoa: EOA },
                    authSigner: '0x9999999999999999999999999999999999999999',
                },
            ],
        )

        expect(result).toBeInstanceOf(RpcError)
        expect((result as RpcError).code).toBe(INVALID_SIGNATURE)
    })
})
