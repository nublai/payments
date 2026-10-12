import { describe, expect, it } from 'vitest'
import { zeroAddress } from 'viem'
import { hashTypedData } from 'viem/utils'

import {
    bindPreparedCalls,
    parseQuotePaymentAmount,
    PreparedCallsBindingError,
} from '../../src/helpers/bindPreparedCalls.js'
import { deserializeContext } from '../../src/utils/serialize.js'
import { INTENT_TYPES } from '../../src/types.js'
import { addr, emptyHex, hex } from '../helpers/hex'

const EOA = addr('0x1111111111111111111111111111111111111111')

const USDC = addr('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')

const TARGET = addr('0x2222222222222222222222222222222222222222')

const ORCHESTRATOR = addr('0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8')

const NOW = 1_700_000_000n

const EXPIRY = NOW + 60n

type PreparedOverrides = {
    digest?: string
    paymentAmount?: string
    messageEoa?: number
    nullMessage?: boolean
    nullCall?: boolean
    nullIntent?: boolean
}

function refuseBind(prepared: ReturnType<typeof makePrepared>): string {
    try {
        bindPreparedCalls(prepared, expected)
        throw new Error('expected bindPreparedCalls to refuse')
    } catch (error) {
        if (error instanceof PreparedCallsBindingError) return error.message

        throw error
    }
}

function makePrepared(overrides: PreparedOverrides = {}) {
    const calls = overrides.nullCall
        ? [null]
        : [{ to: TARGET, value: 1n, data: hex('0x1234') }]

    const message = {
        multichain: false,
        eoa: overrides.messageEoa === undefined ? EOA : overrides.messageEoa,
        calls,
        nonce: 7n,
        payer: EOA,
        paymentToken: USDC,
        paymentMaxAmount: 2000n,
        combinedGas: 50_000n,
        encodedPreCalls: emptyHex(),
        encodedFundTransfers: emptyHex(),
        settler: zeroAddress,
        expiry: EXPIRY,
    }

    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId: 8453,
        verifyingContract: ORCHESTRATOR,
    }

    const digest = hashTypedData({
        domain,
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message: {
            ...message,
            eoa: EOA,
            calls: [{ to: TARGET, value: 1n, data: hex('0x1234') }],
        },
    })

    return {
        digest: overrides.digest ?? digest,
        typedData: {
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message: overrides.nullMessage ? null : message,
        },
        context: {
            quote: {
                quotes: [
                    {
                        chainId: '0x2105',
                        orchestrator: ORCHESTRATOR,
                        paymentAmount: overrides.paymentAmount ?? '1000',
                        extra: 1,
                        intent: overrides.nullIntent
                            ? null
                            : {
                                  eoa: EOA,
                                  calls: [{ to: TARGET, value: '1', data: '0x1234' }],
                                  nonce: '7',
                                  payer: EOA,
                                  paymentToken: USDC,
                                  paymentMaxAmount: '2000',
                                  combinedGas: '50000',
                                  encodedPreCalls: [],
                                  encodedFundTransfers: [],
                                  settler: zeroAddress,
                                  expiry: EXPIRY.toString(),
                              },
                    },
                ],
                signature: '0x',
                ttl: 1,
            },
        },
        capabilities: { feeTotals: {}, assetDiffs: {} },
        signature: '0x',
    }
}

const expected = {
    from: EOA,
    calls: [{ target: TARGET, value: 1n, data: hex('0x1234') }],
    chainId: 8453,
    verifyingContract: ORCHESTRATOR,
    nonce: 7n,
    expiry: EXPIRY,
    combinedGasCeiling: 1_000_000n,
    now: NOW,
    payer: EOA,
    paymentToken: USDC,
    paymentMaxAmount: 2000n,
}

describe('no-runtime-typeof parity: bind and serialize', () => {
    it('deserializeContext keeps extras and refuses a missing quotes array', () => {
        const ok = deserializeContext(
            JSON.stringify({ quote: { quotes: [{ extra: 1 }], ttl: 1 }, keep: true }),
        )

        expect(ok.quote.quotes).toHaveLength(1)
        expect(ok).toMatchObject({ keep: true })
        expect(() => deserializeContext('null')).toThrow('Invalid PrepareCallsContext')
        expect(() => deserializeContext('[]')).toThrow('Invalid PrepareCallsContext')
        expect(() => deserializeContext('{"quote":null}')).toThrow('Invalid PrepareCallsContext')
        expect(() => deserializeContext('{"quote":{}}')).toThrow('Invalid PrepareCallsContext')
        expect(() => deserializeContext('{"quote":{"quotes":{}}}')).toThrow(
            'Invalid PrepareCallsContext',
        )
        expect(deserializeContext('{"quote":{"quotes":[]},"__proto__":{"x":1}}').quote.quotes).toEqual(
            [],
        )
    })

    it('parseQuotePaymentAmount keeps missing vs invalid', () => {
        expect(parseQuotePaymentAmount(undefined)).toEqual({ ok: false, reason: 'missing' })
        expect(parseQuotePaymentAmount(null)).toEqual({ ok: false, reason: 'missing' })
        expect(parseQuotePaymentAmount('')).toEqual({ ok: false, reason: 'missing' })
        expect(parseQuotePaymentAmount(1n)).toEqual({ ok: true, amount: 1n })
        expect(parseQuotePaymentAmount(-1n)).toEqual({ ok: false, reason: 'invalid' })
        expect(parseQuotePaymentAmount(2)).toEqual({ ok: true, amount: 2n })
        expect(parseQuotePaymentAmount(1.5)).toEqual({ ok: false, reason: 'invalid' })
        expect(parseQuotePaymentAmount('3')).toEqual({ ok: true, amount: 3n })
        expect(parseQuotePaymentAmount('-1')).toEqual({ ok: false, reason: 'invalid' })
        expect(parseQuotePaymentAmount({})).toEqual({ ok: false, reason: 'invalid' })
        expect(parseQuotePaymentAmount([])).toEqual({ ok: false, reason: 'invalid' })
    })

    it('bindPreparedCalls refuses a missing message, bad digest, and mismatched quote', () => {
        expect(refuseBind(makePrepared({ nullMessage: true }))).toBe(
            'Refusing to sign prepared calls: typed data message is missing',
        )
        expect(refuseBind(makePrepared({ digest: '0xdead' }))).toBe(
            'Refusing to sign prepared calls: digest does not match',
        )
        expect(refuseBind(makePrepared({ nullIntent: true }))).toBe(
            'Refusing to sign prepared calls: quote does not match the signed intent',
        )
        expect(refuseBind(makePrepared({ messageEoa: 1 }))).toBe(
            'Refusing to sign prepared calls: missing typed data eoa',
        )
        expect(refuseBind(makePrepared({ nullCall: true }))).toBe(
            'Refusing to sign prepared calls: invalid typed data calls[0]',
        )
    })

    it('bindPreparedCalls still signs a matching quote', () => {
        const prepared = makePrepared()
        const bound = bindPreparedCalls(prepared, expected)

        expect(bound.digest).toBe(prepared.digest)
        expect(bound.typedData.primaryType).toBe('Intent')
        expect(bound.typedData.message.eoa).toBe(EOA)
    })
})
