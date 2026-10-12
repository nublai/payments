import { describe, expect, it } from 'vitest'

import { peekJwtIssuer } from '../src/auth/jwt-peek'
import { extractAuthRequirement } from '../src/auth/policy'
import { bindingFromRpcBody, parseChainId } from '../src/auth/erc8128/signer-policy'
import { dispatch } from '../src/rpc/dispatcher'
import { recomputeQuotePaymentAmount } from '../src/services/quote-payment'
import { PARSE_ERROR, INVALID_REQUEST } from '../src/rpc/errors'
import type { MethodRegistry, RpcContext } from '../src/rpc/types'

const PROTECTED = new Set(['wallet_sendPreparedCalls', 'wallet_prepareCalls'])

const methods: MethodRegistry = {
    wallet_health: async () => ({ ok: true }),
}

const ctx: RpcContext = { env: {} }

type JwtPeekPayload = {
    iss?: string | number
    aud?: string
    extra?: number
}

function jwt(payload: JwtPeekPayload): string {
    return `aaa.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.bbb`
}

describe('no-runtime-typeof parity: auth and rpc envelopes', () => {
    it('extractAuthRequirement keeps main allow/refuse for single and batch bodies', () => {
        expect(
            extractAuthRequirement(
                { jsonrpc: '2.0', id: 1, method: 'wallet_sendPreparedCalls', params: [] },
                PROTECTED,
            ),
        ).toEqual({ requiresAuth: true, id: 1 })
        expect(
            extractAuthRequirement(
                { jsonrpc: '2.0', id: 'abc', method: 'wallet_health', params: [] },
                PROTECTED,
            ),
        ).toEqual({ requiresAuth: false, id: 'abc' })
        expect(
            extractAuthRequirement(
                { jsonrpc: '2.0', id: { nested: true }, method: 'wallet_health', params: [] },
                PROTECTED,
            ),
        ).toEqual({ requiresAuth: false, id: null })
        expect(
            extractAuthRequirement({ method: 'wallet_sendPreparedCalls' }, PROTECTED),
        ).toEqual({ requiresAuth: true, id: null })
        expect(extractAuthRequirement({ method: 1, id: 1 }, PROTECTED)).toEqual({
            requiresAuth: false,
            id: 1,
        })
        expect(extractAuthRequirement(null, PROTECTED)).toEqual({
            requiresAuth: false,
            id: null,
        })
        expect(extractAuthRequirement('x', PROTECTED)).toEqual({
            requiresAuth: false,
            id: null,
        })
        expect(
            extractAuthRequirement(
                [{ method: 'wallet_health' }, { method: 'wallet_sendPreparedCalls' }],
                PROTECTED,
            ),
        ).toEqual({ requiresAuth: true, id: null })
        expect(
            extractAuthRequirement(
                JSON.parse('{"method":"wallet_sendPreparedCalls","id":1,"__proto__":{"x":1}}'),
                PROTECTED,
            ),
        ).toEqual({ requiresAuth: true, id: 1 })
        expect(
            extractAuthRequirement(
                { method: 'wallet_sendPreparedCalls', extra: 1, params: { foo: 1 } },
                PROTECTED,
            ),
        ).toEqual({ requiresAuth: true, id: null })
        expect(
            extractAuthRequirement(
                { method: 'wallet_sendPreparedCalls', id: Number.POSITIVE_INFINITY },
                PROTECTED,
            ),
        ).toEqual({ requiresAuth: true, id: Number.POSITIVE_INFINITY })
    })

    it('parseChainId keeps main accept/refuse', () => {
        expect(parseChainId(1)).toBe(1)
        expect(parseChainId(8453)).toBe(8453)
        expect(parseChainId(0)).toBeUndefined()
        expect(parseChainId(-1)).toBeUndefined()
        expect(parseChainId(1.5)).toBeUndefined()
        expect(parseChainId(Number.POSITIVE_INFINITY)).toBeUndefined()
        expect(parseChainId('1')).toBe(1)
        expect(parseChainId('0x21')).toBe(33)
        expect(parseChainId(' 1 ')).toBe(1)
        expect(parseChainId('1e2')).toBeUndefined()
        expect(parseChainId('0xzz')).toBeUndefined()
        expect(parseChainId(null)).toBeUndefined()
        expect(parseChainId({})).toBeUndefined()
        expect(parseChainId([])).toBeUndefined()
        expect(parseChainId(9007199254740991)).toBe(9007199254740991)
    })

    it('peekJwtIssuer accepts only a string iss', () => {
        expect(peekJwtIssuer(jwt({ iss: 'https://issuer.example' }))).toBe(
            'https://issuer.example',
        )
        expect(peekJwtIssuer(jwt({ iss: 1 }))).toBeUndefined()
        expect(peekJwtIssuer(jwt({}))).toBeUndefined()
        expect(peekJwtIssuer(jwt({ iss: 'https://issuer.example', extra: 1 }))).toBe(
            'https://issuer.example',
        )
        expect(peekJwtIssuer('not-a-jwt')).toBeUndefined()
        expect(peekJwtIssuer(jwt({ iss: '', aud: 'x' }))).toBe('')
    })

    it('bindingFromRpcBody still refuses a send with no EOA', () => {
        const binding = bindingFromRpcBody(
            {
                method: 'wallet_sendPreparedCalls',
                params: { context: { quote: { quotes: [{ intent: {}, chainId: 8453 }] } } },
            },
            new Set(['wallet_sendPreparedCalls']),
        )

        expect(binding).toEqual({ accounts: [], otherProtectedMethods: [] })
    })

    it('bindingFromRpcBody reads prepare from/chain_id and ignores extra fields', () => {
        const eoa = '0x1111111111111111111111111111111111111111'

        expect(
            bindingFromRpcBody({
                method: 'wallet_prepareCalls',
                params: { from: eoa, chain_id: '0x21', extra: 1 },
            }).accounts,
        ).toEqual([{ eoa, chainId: 33 }])
        expect(
            bindingFromRpcBody(
                JSON.parse(
                    `{"method":"wallet_prepareCalls","params":{"from":"${eoa}","chain_id":"0x21","__proto__":{"x":1}}}`,
                ),
            ).accounts,
        ).toEqual([{ eoa, chainId: 33 }])
    })

    it('dispatch keeps parse vs invalid vs success', async () => {
        expect(await dispatch('not json', methods, ctx)).toMatchObject({
            error: { code: PARSE_ERROR },
        })
        expect(await dispatch(1, methods, ctx)).toMatchObject({
            error: { code: PARSE_ERROR },
        })
        expect(await dispatch(null, methods, ctx)).toMatchObject({
            error: { code: PARSE_ERROR },
        })
        expect(await dispatch({ method: 'wallet_health', id: 1 }, methods, ctx)).toMatchObject({
            error: { code: INVALID_REQUEST },
        })
        expect(
            await dispatch({ jsonrpc: '1.0', method: 'wallet_health', id: 1 }, methods, ctx),
        ).toMatchObject({
            error: { code: INVALID_REQUEST },
        })
        expect(await dispatch({ jsonrpc: '2.0', method: 1, id: 1 }, methods, ctx)).toMatchObject({
            error: { code: INVALID_REQUEST },
        })
        // Main extractId treats a non-string/number/null id as missing, so the
        // invalid-id request is answered as a notification (null), not -32600.
        expect(
            await dispatch({ jsonrpc: '2.0', method: 'wallet_health', id: { x: 1 } }, methods, ctx),
        ).toBeNull()
        expect(
            await dispatch({ jsonrpc: '2.0', method: 'wallet_health', id: 1, params: 1 }, methods, ctx),
        ).toMatchObject({ error: { code: INVALID_REQUEST } })
        expect(
            await dispatch({ jsonrpc: '2.0', method: 'wallet_health', id: 1, params: null }, methods, ctx),
        ).toMatchObject({ result: { ok: true } })
        expect(
            await dispatch(
                { jsonrpc: '2.0', method: 'wallet_health', id: 1, extra: true },
                methods,
                ctx,
            ),
        ).toMatchObject({ result: { ok: true } })
        expect(
            await dispatch(
                JSON.parse('{"jsonrpc":"2.0","method":"wallet_health","id":1,"__proto__":{"x":1}}'),
                methods,
                ctx,
            ),
        ).toMatchObject({ result: { ok: true } })
    })

    it('quote payment still refuses bad decimals and non-numeric gas', () => {
        expect(() =>
            recomputeQuotePaymentAmount({
                txGas: 'x',
                maxFeePerGas: 1,
            }),
        ).toThrow('Invalid txGas')
        expect(() =>
            recomputeQuotePaymentAmount({
                txGas: 1,
                maxFeePerGas: Number.POSITIVE_INFINITY,
            }),
        ).toThrow('Invalid maxFeePerGas')
        expect(
            recomputeQuotePaymentAmount({
                txGas: 2,
                maxFeePerGas: 3,
            }),
        ).toBe(6n)
        expect(() =>
            recomputeQuotePaymentAmount({
                txGas: 1,
                maxFeePerGas: 1,
                paymentToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                paymentTokenDecimals: 1.5,
                nativeRate: '1',
            }),
        ).toThrow('Quote paymentTokenDecimals is invalid')
    })
})
