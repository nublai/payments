import { expect, test } from 'bun:test'
import { INTENT_TYPES } from '@nubl/relayer-client'
import { isDefinitivePreBroadcastRefusal } from '../src/lib/execute-calls'
import { getIntentStatus, getQuote, type RelayQuoteRequest } from '../src/lib/relay-link'
import { assertOrderRecipients, hashRelayOrder, orderPayees } from '../src/lib/relay-order'
import {
    assessPhraseLessIntent,
    reviewSwapSessionSignature,
    typesMatch,
} from '../src/lib/session-daemon-policy'
import { parseDaemonRequest, parseDaemonResponse } from '../src/lib/session-daemon-protocol'

const USER = '0x1111111111111111111111111111111111111111'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const ZERO_ONE = '0x0000000000000000000000000000000000000001'

test('parseDaemonRequest locks valid, extra, proto, and check-order payloads', () => {
    expect(parseDaemonRequest('{"id":"a","method":"ping","params":{}}')).toEqual({
        id: 'a',
        method: 'ping',
        params: {},
    })
    expect(parseDaemonRequest('{"id":"a","method":"ping","params":{},"extra":1}')).toEqual({
        id: 'a',
        method: 'ping',
        params: {},
    })
    expect(parseDaemonRequest('{"id":"a","method":"list","params":{}}').method).toBe('list')

    expect(() => parseDaemonRequest('null')).toThrow('Invalid daemon request payload')
    expect(() => parseDaemonRequest('[]')).toThrow('Invalid daemon request payload')
    expect(() => parseDaemonRequest('1')).toThrow('Invalid daemon request payload')
    expect(() => parseDaemonRequest('"x"')).toThrow('Invalid daemon request payload')
    expect(() => parseDaemonRequest('{}')).toThrow('Invalid daemon request payload')
    expect(() => parseDaemonRequest('{"id":"a","method":1,"params":{}}')).toThrow(
        'Invalid daemon request payload',
    )
    expect(() => parseDaemonRequest('{"id":1,"method":"ping","params":{}}')).toThrow(
        'Invalid daemon request id',
    )
    expect(() => parseDaemonRequest('{"id":"a","method":"unknown","params":{}}')).toThrow(
        'Unknown daemon method: unknown',
    )
    expect(() => parseDaemonRequest('{"id":"a","method":"ping"}')).toThrow(
        'Invalid daemon request params',
    )
    expect(() => parseDaemonRequest('{"id":"a","method":"ping","params":[]}')).toThrow(
        'Invalid daemon request params',
    )
    expect(() => parseDaemonRequest('{"id":"a","method":"ping","params":null}')).toThrow(
        'Invalid daemon request params',
    )
    expect(() => parseDaemonRequest('{')).toThrow()

    const proto = parseDaemonRequest('{"id":"a","method":"ping","params":{},"__proto__":{"x":1}}')

    expect(proto.method).toBe('ping')
    expect(
        parseDaemonRequest('{"id":"a","method":"ping","params":{},"constructor":{"x":1}}').method,
    ).toBe('ping')
    expect(() => parseDaemonRequest('{"method":1,"id":"a","params":{}}')).toThrow(
        'Invalid daemon request payload',
    )
    expect(() => parseDaemonRequest('{"id":"a","method":"nope","params":{}}')).toThrow(
        'Unknown daemon method: nope',
    )
})

test('parseDaemonRequest locks sign, loadKey, and session-name methods', () => {
    const sign = parseDaemonRequest(
        JSON.stringify({
            id: 's',
            method: 'sign',
            params: {
                sessionName: 'pay',
                typedData: {
                    domain: { chainId: 8453 },
                    types: {},
                    primaryType: 'Intent',
                    message: { n: '$bigint:1' },
                },
            },
        }),
    )

    expect(sign.method).toBe('sign')

    if (sign.method === 'sign') {
        expect(sign.params.sessionName).toBe('pay')
        expect(sign.params.typedData.message.n).toBe(1n)
        expect(Object.hasOwn(sign.params.typedData, 'domain')).toBe(true)
    }

    expect(() =>
        parseDaemonRequest('{"id":"s","method":"sign","params":{"sessionName":"pay"}}'),
    ).toThrow('Invalid sign params.typedData')
    expect(() =>
        parseDaemonRequest(
            '{"id":"s","method":"sign","params":{"sessionName":"pay","typedData":null}}',
        ),
    ).toThrow('Invalid sign params.typedData')
    expect(() =>
        parseDaemonRequest(
            '{"id":"s","method":"sign","params":{"sessionName":"pay","typedData":"x"}}',
        ),
    ).toThrow('Invalid sign params.typedData')
    expect(() =>
        parseDaemonRequest(
            '{"id":"s","method":"sign","params":{"sessionName":"pay","typedData":[]}}',
        ),
    ).toThrow('Invalid sign params.typedData')
    expect(() =>
        parseDaemonRequest('{"id":"s","method":"sign","params":{"sessionName":1,"typedData":{}}}'),
    ).toThrow('Invalid sign params.sessionName')

    const protoTyped = parseDaemonRequest(
        '{"id":"s","method":"sign","params":{"sessionName":"pay","typedData":{"__proto__":{"x":1},"domain":{}}}}',
    )

    if (protoTyped.method === 'sign') {
        expect(Object.hasOwn(protoTyped.params.typedData, '__proto__')).toBe(true)
    }

    expect(
        parseDaemonRequest(
            '{"id":"m","method":"signMessage","params":{"sessionName":"pay","message":"0xab"}}',
        ).method,
    ).toBe('signMessage')
    expect(() =>
        parseDaemonRequest('{"id":"m","method":"signMessage","params":{"sessionName":"pay"}}'),
    ).toThrow('Invalid signMessage params')
    expect(() =>
        parseDaemonRequest(
            '{"id":"m","method":"signMessage","params":{"sessionName":"pay","message":1}}',
        ),
    ).toThrow('Invalid signMessage params')

    const load = parseDaemonRequest(
        JSON.stringify({
            id: 'l',
            method: 'loadKey',
            params: { name: 'n', privateKey: '0x11', address: '0x22', durationSeconds: 60 },
        }),
    )

    expect(load.method).toBe('loadKey')

    const loadOptional = parseDaemonRequest(
        JSON.stringify({
            id: 'l',
            method: 'loadKey',
            params: {
                name: 'n',
                privateKey: '0x11',
                address: '0x22',
                durationSeconds: 60,
                kind: 'agent',
                encryptionDevice: '0x33',
                phraseConfirmed: true,
                swapSession: false,
                env: 'dev',
            },
        }),
    )

    if (loadOptional.method === 'loadKey') {
        expect(loadOptional.params.kind).toBe('agent')
        expect(loadOptional.params.phraseConfirmed).toBe(true)
        expect(loadOptional.params.env).toBe('dev')
    }

    expect(() =>
        parseDaemonRequest(
            JSON.stringify({
                id: 'l',
                method: 'loadKey',
                params: { name: 'n', privateKey: '0x11', address: '0x22', durationSeconds: 60, kind: 1 },
            }),
        ),
    ).toThrow('Invalid loadKey params')
    expect(() =>
        parseDaemonRequest(
            JSON.stringify({
                id: 'l',
                method: 'loadKey',
                params: {
                    name: 'n',
                    privateKey: '0x11',
                    address: '0x22',
                    durationSeconds: 60,
                    env: 'other',
                },
            }),
        ),
    ).toThrow('Invalid loadKey params')
    expect(() =>
        parseDaemonRequest(
            '{"id":"l","method":"loadKey","params":{"name":"n","privateKey":"0x11","address":"0x22","durationSeconds":1e400}}',
        ),
    ).toThrow('Invalid loadKey params')
    expect(() =>
        parseDaemonRequest(
            '{"id":"l","method":"loadKey","params":{"name":"n","privateKey":"0x11","address":"0x22","durationSeconds":-1e400}}',
        ),
    ).toThrow('Invalid loadKey params')
    expect(
        parseDaemonRequest(
            '{"id":"l","method":"loadKey","params":{"name":"n","privateKey":"0x11","address":"0x22","durationSeconds":-1}}',
        ).method,
    ).toBe('loadKey')
    expect(() =>
        parseDaemonRequest(
            '{"id":"l","method":"loadKey","params":{"name":"n","privateKey":"0x11","address":"0x22","durationSeconds":"60"}}',
        ),
    ).toThrow('Invalid loadKey params')
    expect(() =>
        parseDaemonRequest(
            '{"id":"l","method":"loadKey","params":{"privateKey":"0x11","address":"0x22","durationSeconds":60}}',
        ),
    ).toThrow('Invalid loadKey params')
    expect(() =>
        parseDaemonRequest(
            JSON.stringify({
                id: 'l',
                method: 'loadKey',
                params: {
                    name: 'n',
                    privateKey: '0x11',
                    address: '0x22',
                    durationSeconds: 60,
                    phraseConfirmed: null,
                },
            }),
        ),
    ).toThrow('Invalid loadKey params')
    expect(
        parseDaemonRequest(
            '{"id":"g","method":"getSessionSecrets","params":{"sessionName":"pay"}}',
        ).method,
    ).toBe('getSessionSecrets')
    expect(() => parseDaemonRequest('{"id":"g","method":"getSessionSecrets","params":{}}')).toThrow(
        'Invalid getSessionSecrets params.sessionName',
    )
    expect(
        parseDaemonRequest('{"id":"r","method":"remove","params":{"sessionName":"pay"}}').method,
    ).toBe('remove')
    expect(() =>
        parseDaemonRequest('{"id":"r","method":"remove","params":{"sessionName":1}}'),
    ).toThrow('Invalid remove params.sessionName')
})

test('parseDaemonResponse locks extras, proto, and error order', () => {
    expect(parseDaemonResponse('{"id":"a","result":{"ok":true}}')).toEqual({
        id: 'a',
        result: { ok: true },
    })

    const extra = parseDaemonResponse('{"id":"a","result":{"ok":true,"extra":1}}')

    expect(extra).toEqual({ id: 'a', result: { ok: true, extra: 1 } })

    const err = parseDaemonResponse(
        '{"id":"b","error":{"code":"SESSION_NOT_FOUND","message":"missing"}}',
    )

    expect('error' in err && err.error.code).toBe('SESSION_NOT_FOUND')
    expect(() => parseDaemonResponse('{"id":"a","error":{"code":"NOT_REAL","message":"x"}}')).toThrow(
        'Unknown daemon response error code: NOT_REAL',
    )
    expect(() => parseDaemonResponse('{"id":"a","error":null}')).toThrow(
        'Invalid daemon response error',
    )
    expect(() => parseDaemonResponse('{"id":"a","error":[]}')).toThrow(
        'Invalid daemon response error',
    )
    expect(() => parseDaemonResponse('{"id":"a","error":{"code":1,"message":"x"}}')).toThrow(
        'Invalid daemon response error payload',
    )
    expect(() => parseDaemonResponse('{"id":1,"result":1}')).toThrow('Invalid daemon response id')
    expect(() => parseDaemonResponse('null')).toThrow('Invalid daemon response payload')
    expect(() => parseDaemonResponse('[]')).toThrow('Invalid daemon response payload')
    expect(parseDaemonResponse('{"id":"a","result":1,"__proto__":{"x":1}}').id).toBe('a')
    expect(() => parseDaemonResponse('{')).toThrow()
})

function baseIntent() {
    return {
        domain: {
            name: 'Orchestrator',
            version: '0.5.5',
            chainId: 8453,
            verifyingContract: ZERO_ONE,
        },
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message: {
            multichain: false,
            encodedPreCalls: new Array<string>(),
            encodedFundTransfers: new Array<string>(),
            calls: new Array<object>(),
            paymentToken: USDC,
            paymentMaxAmount: 0n,
            eoa: USER,
        },
    }
}

test('phrase-less and swap reviewers refuse malformed envelopes', () => {
    expect(() => assessPhraseLessIntent({ typedData: null, env: 'dev' })).toThrow(
        'Phrase-less sessions can only sign Orchestrator intents',
    )
    expect(() => assessPhraseLessIntent({ typedData: [], env: 'dev' })).toThrow(
        'Phrase-less sessions can only sign Orchestrator intents',
    )
    expect(() => assessPhraseLessIntent({ typedData: 'x', env: 'dev' })).toThrow(
        'Phrase-less sessions can only sign Orchestrator intents',
    )
    expect(() => assessPhraseLessIntent({ typedData: {}, env: 'dev' })).toThrow(
        'Phrase-less sessions can only sign Orchestrator intents',
    )
    expect(() =>
        assessPhraseLessIntent({ typedData: { ...baseIntent(), domain: null }, env: 'dev' }),
    ).toThrow('Phrase-less sessions can only sign Orchestrator intents')
    expect(() =>
        assessPhraseLessIntent({ typedData: { ...baseIntent(), domain: 'x' }, env: 'dev' }),
    ).toThrow('Phrase-less sessions can only sign Orchestrator intents')
    expect(() =>
        assessPhraseLessIntent({
            typedData: {
                ...baseIntent(),
                domain: {
                    name: 'USD Coin',
                    version: '0.5.5',
                    chainId: 8453,
                    verifyingContract: ZERO_ONE,
                },
            },
            env: 'dev',
        }),
    ).toThrow('Phrase-less sessions can only sign Orchestrator intents')
    expect(() =>
        assessPhraseLessIntent({ typedData: { ...baseIntent(), primaryType: 'Permit' }, env: 'dev' }),
    ).toThrow('Phrase-less sessions can only sign Orchestrator intents')
    expect(() =>
        assessPhraseLessIntent({ typedData: { ...baseIntent(), types: null }, env: 'dev' }),
    ).toThrow('Phrase-less sessions can only sign Orchestrator intents')
    expect(() =>
        assessPhraseLessIntent({ typedData: { ...baseIntent(), types: {} }, env: 'dev' }),
    ).toThrow('Phrase-less sessions can only sign Orchestrator intents')
    expect(() => assessPhraseLessIntent({ typedData: baseIntent(), env: undefined })).toThrow(
        'Phrase-less session cannot sign because unlock did not record an environment',
    )

    const withPreCalls = baseIntent()

    withPreCalls.message.encodedPreCalls = ['0x']
    expect(() => assessPhraseLessIntent({ typedData: withPreCalls, env: 'dev' })).toThrow()

    expect(() => reviewSwapSessionSignature(null)).toThrow()
    expect(() => reviewSwapSessionSignature([])).toThrow()
    expect(() => reviewSwapSessionSignature('x')).toThrow()
    expect(() => reviewSwapSessionSignature({})).toThrow()
    expect(typesMatch(null)).toBe(false)
    expect(typesMatch([])).toBe(false)
    expect(typesMatch({})).toBe(false)
    expect(typesMatch(INTENT_TYPES)).toBe(true)
})

const orderBase = {
    version: 'v1',
    solverChainId: 'base',
    solver: '0xf70da97812cb96acdf810712aa562db8dfa3dbef',
    salt: '1',
    inputs: [
        {
            payment: { chainId: '8453', currency: USDC, amount: '1', weight: '1' },
            refunds: [
                {
                    chainId: '8453',
                    recipient: USER,
                    currency: USDC,
                    minimumAmount: '1',
                    deadline: 1,
                    extraData: '0x',
                },
            ],
        },
    ],
    output: {
        chainId: '137',
        payments: [
            {
                recipient: USER,
                currency: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
                minimumAmount: '1',
                expectedAmount: '1',
            },
        ],
        deadline: 1,
        calls: new Array<string>(),
        extraData: '0x',
    },
    fees: [
        {
            recipientChainId: '8453',
            recipient: USER,
            currencyChainId: '8453',
            currency: USDC,
            amount: '1',
        },
    ],
}

test('relay order hash and recipient checks refuse malformed orders and keep 2^53 amounts', () => {
    expect(() => hashRelayOrder(null)).toThrow('relay.link quote is missing protocol.v2.orderData.')
    expect(() => hashRelayOrder([])).toThrow('relay.link quote is missing protocol.v2.orderData.')
    expect(() => hashRelayOrder('x')).toThrow('relay.link quote is missing protocol.v2.orderData.')
    expect(() => hashRelayOrder({})).toThrow(
        'relay.link order version is not v1. Refusing to bind the deposit id.',
    )
    expect(() => hashRelayOrder({ ...orderBase, version: 'v2' })).toThrow(
        'relay.link order version is not v1. Refusing to bind the deposit id.',
    )
    expect(() => hashRelayOrder({ ...orderBase, solver: '0x1' })).toThrow(
        'relay.link order solver is not a 20-byte address.',
    )
    expect(() => hashRelayOrder({ ...orderBase, inputs: [] })).toThrow(
        'relay.link order is missing inputs.',
    )
    expect(() => hashRelayOrder({ ...orderBase, inputs: ['x'] })).toThrow(
        'relay.link order input is malformed.',
    )
    expect(() => hashRelayOrder({ ...orderBase, output: null })).toThrow(
        'relay.link order is missing output payments.',
    )
    expect(
        hashRelayOrder({ ...orderBase, output: { ...orderBase.output, calls: ['0x'] } }),
    ).toMatch(/^0x[0-9a-f]{64}$/)
    expect(() => assertOrderRecipients(orderBase, USER, USER)).not.toThrow()

    const zeroMin = {
        ...orderBase,
        output: {
            ...orderBase.output,
            payments: [{ ...orderBase.output.payments[0], minimumAmount: '0' }],
        },
    }

    expect(() => assertOrderRecipients(zeroMin, USER, USER)).toThrow(
        'relay.link order output minimum is 0. Refusing to sign.',
    )

    const infMin = {
        ...orderBase,
        output: {
            ...orderBase.output,
            payments: [{ ...orderBase.output.payments[0], minimumAmount: Number('1e400') }],
        },
    }

    expect(() => assertOrderRecipients(infMin, USER, USER)).toThrow(
        'relay.link order output.minimumAmount is not an amount.',
    )

    const unsafeInt = {
        ...orderBase,
        output: {
            ...orderBase.output,
            payments: [{ ...orderBase.output.payments[0], minimumAmount: 2 ** 53 }],
        },
    }

    expect(() => assertOrderRecipients(unsafeInt, USER, USER)).not.toThrow()
    expect(orderPayees(orderBase).outputs.length).toBeGreaterThan(0)
})

test('getQuote and getIntentStatus decode extras, proto, and API errors at the HTTP boundary', async () => {
    const quoteOk = {
        requestId: 'q1',
        steps: [
            {
                id: 's1',
                kind: 'transaction',
                items: [
                    {
                        status: 'incomplete',
                        data: {
                            to: '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f',
                            data: '0xcd6e13f7',
                            value: '0',
                            chainId: 8453,
                        },
                        check: {
                            endpoint: 'https://api.relay.link/intents/status/v3?requestId=q1',
                            method: 'GET',
                        },
                    },
                ],
            },
        ],
        fees: { gas: { amountUsd: '0.1' } },
        details: { currencyIn: { amount: '1' }, currencyOut: { amount: '1', minimumAmount: '1' } },
    }

    const request: RelayQuoteRequest = {
        user: USER,
        originChainId: 8453,
        destinationChainId: 8453,
        originCurrency: USDC,
        destinationCurrency: USDC,
        amount: '1',
        tradeType: 'EXACT_INPUT',
        slippageTolerance: '50',
    }

    const ok = await getQuote(request, {
        fetch: async () =>
            new Response(JSON.stringify(quoteOk), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        env: 'prod',
    })

    expect(ok.requestId).toBe('q1')
    expect(ok.details?.currencyOut?.minimumAmount).toBe('1')

    const extras = await getQuote(request, {
        fetch: async () =>
            new Response(
                JSON.stringify({
                    ...quoteOk,
                    details: { currencyIn: { amount: '1', extra: true }, extraTop: 1 },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        env: 'prod',
    })

    expect(JSON.parse(JSON.stringify(extras.details)).extraTop).toBe(1)
    expect(JSON.parse(JSON.stringify(extras.details?.currencyIn)).extra).toBe(true)

    await expect(
        getQuote(request, {
            fetch: async () =>
                new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
            env: 'prod',
        }),
    ).rejects.toThrow()
    await expect(
        getQuote(request, {
            fetch: async () =>
                new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
            env: 'prod',
        }),
    ).rejects.toThrow()
    await expect(
        getQuote(request, {
            fetch: async () =>
                new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
            env: 'prod',
        }),
    ).rejects.toThrow()
    await expect(
        getQuote(request, {
            fetch: async () =>
                new Response(JSON.stringify({ message: 'nope' }), {
                    status: 400,
                    headers: { 'content-type': 'application/json' },
                }),
            env: 'prod',
        }),
    ).rejects.toThrow('nope')
    await expect(
        getQuote(request, {
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        steps: [
                            {
                                items: [
                                    {
                                        status: 'incomplete',
                                        data: {
                                            to: '0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f',
                                            data: '0x',
                                            value: '0',
                                            chainId: Number('1e400'),
                                        },
                                    },
                                ],
                            },
                        ],
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            env: 'prod',
        }),
    ).rejects.toThrow()

    const status = await getIntentStatus('q1', {
        fetch: async () =>
            new Response(JSON.stringify({ status: 'success', requestId: 'q1' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        env: 'prod',
    })

    expect(status.status).toBe('success')
    await expect(
        getIntentStatus('q1', {
            fetch: async () =>
                new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
            env: 'prod',
        }),
    ).rejects.toThrow()
    await expect(
        getIntentStatus('q1', {
            fetch: async () =>
                new Response(JSON.stringify({ status: 1 }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            env: 'prod',
        }),
    ).rejects.toThrow()
})

test('pre-broadcast refusal codes stay refusals for malformed errors', () => {
    expect(isDefinitivePreBroadcastRefusal({ code: -32602 })).toBe(true)
    expect(isDefinitivePreBroadcastRefusal({ code: -32005 })).toBe(true)
    expect(isDefinitivePreBroadcastRefusal({ code: -32099 })).toBe(false)
    expect(isDefinitivePreBroadcastRefusal(null)).toBe(false)
    expect(isDefinitivePreBroadcastRefusal('x')).toBe(false)
    expect(isDefinitivePreBroadcastRefusal({ code: 'x' })).toBe(false)
    expect(isDefinitivePreBroadcastRefusal({ code: 1.5 })).toBe(false)
    expect(isDefinitivePreBroadcastRefusal({ code: Number('1e400') })).toBe(false)
    expect(isDefinitivePreBroadcastRefusal({ code: 2 ** 53 + 1 })).toBe(false)
    expect(isDefinitivePreBroadcastRefusal(Object.assign(new Error('e'), { code: -32602 }))).toBe(
        true,
    )
    expect(isDefinitivePreBroadcastRefusal(JSON.parse('{"code":-32602,"__proto__":{"x":1}}'))).toBe(
        true,
    )
})
