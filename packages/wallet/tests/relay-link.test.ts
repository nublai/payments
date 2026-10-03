import { expect, mock, test } from 'bun:test'
import {
    extractRequestId,
    getRelayLinkBaseUrl,
    getIntentStatus,
    getQuote,
    pollIntentStatus,
    RelayLinkError,
    slippagePercentToBps,
    stepsToRelayerCalls,
    type RelayQuoteResponse,
} from '../src/lib/relay-link'

test('getRelayLinkBaseUrl uses mainnet relay.link for prod and stage', () => {
    expect(getRelayLinkBaseUrl('prod')).toBe('https://api.relay.link')
    expect(getRelayLinkBaseUrl('stage')).toBe('https://api.relay.link')
    expect(getRelayLinkBaseUrl('dev')).toBe('https://api.testnets.relay.link')
})

test('stepsToRelayerCalls flattens incomplete transaction items only', () => {
    const calls = stepsToRelayerCalls([
        {
            id: 'approve',
            kind: 'transaction',
            items: [
                {
                    status: 'complete',
                    data: {
                        to: '0x1111111111111111111111111111111111111111',
                        data: '0xdeadbeef',
                        value: '0',
                        chainId: 8453,
                    },
                },
                {
                    status: 'incomplete',
                    data: {
                        to: '0x2222222222222222222222222222222222222222',
                        data: '0xbeefdead',
                        value: '12',
                        chainId: 8453,
                    },
                },
            ],
        },
        {
            id: 'sign',
            kind: 'signature',
            items: [],
        },
        {
            id: 'swap',
            kind: 'transaction',
            items: [
                {
                    status: 'incomplete',
                    data: {
                        to: '0x3333333333333333333333333333333333333333',
                        data: '0xc0ffee',
                        value: '0',
                        chainId: 8453,
                    },
                },
            ],
        },
    ])

    expect(calls).toEqual([
        {
            target: '0x2222222222222222222222222222222222222222',
            value: 12n,
            data: '0xbeefdead',
        },
        {
            target: '0x3333333333333333333333333333333333333333',
            value: 0n,
            data: '0xc0ffee',
        },
    ])
})

test('slippagePercentToBps converts percentages to basis points', () => {
    expect(slippagePercentToBps(0.5)).toBe('50')
    expect(slippagePercentToBps(1)).toBe('100')
    expect(() => slippagePercentToBps(0)).toThrow('Slippage must be a positive percentage')
})

test('extractRequestId prefers top-level value and falls back to check endpoint', () => {
    const explicitQuote: RelayQuoteResponse = {
        requestId: 'quote-request-id',
        steps: [],
    }
    expect(extractRequestId(explicitQuote)).toBe('quote-request-id')

    const endpointFallbackQuote: RelayQuoteResponse = {
        steps: [
            {
                id: 'bridge',
                kind: 'transaction',
                items: [
                    {
                        status: 'incomplete',
                        data: {
                            to: '0x1111111111111111111111111111111111111111',
                            data: '0x',
                            value: '0',
                            chainId: 8453,
                        },
                        check: {
                            endpoint:
                                'https://api.relay.link/intents/status/v3?requestId=fallback-request-id',
                            method: 'GET',
                        },
                    },
                ],
            },
        ],
    }

    expect(extractRequestId(endpointFallbackQuote)).toBe('fallback-request-id')
})

test('getQuote normalizes a successful response', async () => {
    const fetchMock = mock(
        async () =>
            new Response(
                JSON.stringify({
                    requestId: 'request-1',
                    steps: [
                        {
                            id: 'swap',
                            action: 'swap',
                            kind: 'transaction',
                            requestId: 'request-1',
                            items: [
                                {
                                    status: 'incomplete',
                                    data: {
                                        to: '0x1111111111111111111111111111111111111111',
                                        data: '0xdeadbeef',
                                        value: '0',
                                        chainId: 8453,
                                    },
                                },
                            ],
                        },
                    ],
                    details: {
                        rate: '1000',
                        timeEstimate: 2,
                    },
                }),
                { status: 200 },
            ),
    )

    const quote = await getQuote(
        {
            user: '0x2222222222222222222222222222222222222222',
            originChainId: 8453,
            destinationChainId: 8453,
            originCurrency: '0x3333333333333333333333333333333333333333',
            destinationCurrency: '0x0000000000000000000000000000000000000000',
            amount: '1000000',
            tradeType: 'EXACT_INPUT',
            slippageTolerance: '50',
        },
        { fetch: fetchMock as typeof fetch, baseUrl: 'https://api.relay.link' },
    )

    expect(quote.requestId).toBe('request-1')
    expect(quote.steps).toHaveLength(1)
    expect(quote.steps[0]?.items[0]?.data.to).toBe('0x1111111111111111111111111111111111111111')
    const requestOptions = fetchMock.mock.calls[0]?.[1]
    expect(requestOptions?.signal).toBeDefined()
})

test('getQuote surfaces relay.link API errors', async () => {
    const fetchMock = mock(
        async () =>
            new Response(JSON.stringify({ statusCode: 429, message: 'rate limited' }), {
                status: 429,
            }),
    )

    await expect(
        getQuote(
            {
                user: '0x2222222222222222222222222222222222222222',
                originChainId: 8453,
                destinationChainId: 8453,
                originCurrency: '0x3333333333333333333333333333333333333333',
                destinationCurrency: '0x0000000000000000000000000000000000000000',
                amount: '1000000',
                tradeType: 'EXACT_INPUT',
                slippageTolerance: '50',
            },
            { fetch: fetchMock as typeof fetch, baseUrl: 'https://api.relay.link' },
        ),
    ).rejects.toMatchObject({
        name: 'RelayLinkError',
        code: 'API_ERROR',
        statusCode: 429,
        message: 'rate limited',
    })
})

test('getQuote rejects invalid calldata in relay steps', async () => {
    const fetchMock = mock(
        async () =>
            new Response(
                JSON.stringify({
                    steps: [
                        {
                            id: 'swap',
                            kind: 'transaction',
                            items: [
                                {
                                    status: 'incomplete',
                                    data: {
                                        to: '0x1111111111111111111111111111111111111111',
                                        data: 'deadbeef',
                                        value: '0',
                                        chainId: 8453,
                                    },
                                },
                            ],
                        },
                    ],
                }),
                { status: 200 },
            ),
    )

    await expect(
        getQuote(
            {
                user: '0x2222222222222222222222222222222222222222',
                originChainId: 8453,
                destinationChainId: 8453,
                originCurrency: '0x3333333333333333333333333333333333333333',
                destinationCurrency: '0x0000000000000000000000000000000000000000',
                amount: '1000000',
                tradeType: 'EXACT_INPUT',
                slippageTolerance: '50',
            },
            { fetch: fetchMock as typeof fetch, baseUrl: 'https://api.relay.link' },
        ),
    ).rejects.toMatchObject({
        name: 'RelayLinkError',
        code: 'INVALID_RESPONSE',
        message: 'relay.link returned invalid calldata in a step item.',
    } satisfies Partial<RelayLinkError>)
})

test('getQuote rejects unknown step item statuses', async () => {
    const fetchMock = mock(
        async () =>
            new Response(
                JSON.stringify({
                    steps: [
                        {
                            id: 'swap',
                            kind: 'transaction',
                            items: [
                                {
                                    status: 'queued',
                                    data: {
                                        to: '0x1111111111111111111111111111111111111111',
                                        data: '0xdeadbeef',
                                        value: '0',
                                        chainId: 8453,
                                    },
                                },
                            ],
                        },
                    ],
                }),
                { status: 200 },
            ),
    )

    await expect(
        getQuote(
            {
                user: '0x2222222222222222222222222222222222222222',
                originChainId: 8453,
                destinationChainId: 8453,
                originCurrency: '0x3333333333333333333333333333333333333333',
                destinationCurrency: '0x0000000000000000000000000000000000000000',
                amount: '1000000',
                tradeType: 'EXACT_INPUT',
                slippageTolerance: '50',
            },
            { fetch: fetchMock as typeof fetch, baseUrl: 'https://api.relay.link' },
        ),
    ).rejects.toMatchObject({
        name: 'RelayLinkError',
        code: 'INVALID_RESPONSE',
        message: 'relay.link returned an invalid step status.',
    } satisfies Partial<RelayLinkError>)
})

test('getQuote rejects step items without a valid to address', async () => {
    const fetchMock = mock(
        async () =>
            new Response(
                JSON.stringify({
                    steps: [
                        {
                            id: 'swap',
                            kind: 'transaction',
                            items: [
                                {
                                    status: 'incomplete',
                                    data: {
                                        data: '0xdeadbeef',
                                        value: '0',
                                        chainId: 8453,
                                    },
                                },
                            ],
                        },
                    ],
                }),
                { status: 200 },
            ),
    )

    await expect(
        getQuote(
            {
                user: '0x2222222222222222222222222222222222222222',
                originChainId: 8453,
                destinationChainId: 8453,
                originCurrency: '0x3333333333333333333333333333333333333333',
                destinationCurrency: '0x0000000000000000000000000000000000000000',
                amount: '1000000',
                tradeType: 'EXACT_INPUT',
                slippageTolerance: '50',
            },
            { fetch: fetchMock as typeof fetch, baseUrl: 'https://api.relay.link' },
        ),
    ).rejects.toMatchObject({
        name: 'RelayLinkError',
        code: 'INVALID_RESPONSE',
        message: 'relay.link returned an invalid to address in a step item.',
    } satisfies Partial<RelayLinkError>)
})

test('getQuote rejects array payloads where an object response is expected', async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify([]), { status: 200 }))

    await expect(
        getQuote(
            {
                user: '0x2222222222222222222222222222222222222222',
                originChainId: 8453,
                destinationChainId: 8453,
                originCurrency: '0x3333333333333333333333333333333333333333',
                destinationCurrency: '0x0000000000000000000000000000000000000000',
                amount: '1000000',
                tradeType: 'EXACT_INPUT',
                slippageTolerance: '50',
            },
            { fetch: fetchMock as typeof fetch, baseUrl: 'https://api.relay.link' },
        ),
    ).rejects.toMatchObject({
        name: 'RelayLinkError',
        code: 'INVALID_RESPONSE',
        message: 'relay.link returned an invalid quote.',
    } satisfies Partial<RelayLinkError>)
})

test('getIntentStatus parses status responses', async () => {
    const fetchMock = mock(
        async () =>
            new Response(
                JSON.stringify({
                    requestId: 'request-1',
                    status: 'submitted',
                    txHashes: [
                        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    ],
                }),
                { status: 200 },
            ),
    )

    const status = await getIntentStatus('request-1', {
        fetch: fetchMock as typeof fetch,
        baseUrl: 'https://api.relay.link',
    })

    expect(status.status).toBe('submitted')
    expect(status.requestId).toBe('request-1')
    expect(status.txHashes).toEqual([
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ])
    const requestOptions = fetchMock.mock.calls[0]?.[1]
    expect(requestOptions?.signal).toBeDefined()
})

test('pollIntentStatus uses stepped intervals until terminal success', async () => {
    const fetchMock = mock(async () => {
        const statuses = [
            { status: 'waiting' },
            { status: 'pending' },
            {
                status: 'success',
                txHashes: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
            },
        ]
        const next = statuses[Math.min(fetchMock.mock.calls.length, statuses.length - 1)]
        return new Response(JSON.stringify(next), { status: 200 })
    })
    const sleepMock = mock(async (_ms: number) => {})

    const status = await pollIntentStatus(
        'request-1',
        {
            timeoutMs: 5_000,
            intervals: [
                { untilMs: 30_000, everyMs: 2_000 },
                { untilMs: 120_000, everyMs: 5_000 },
            ],
        },
        {
            fetch: fetchMock as typeof fetch,
            sleep: sleepMock,
            baseUrl: 'https://api.relay.link',
        },
    )

    expect(status.status).toBe('success')
    expect(sleepMock.mock.calls.map((call) => call[0])).toEqual([2_000])
})

test('pollIntentStatus throws on timeout with latest status details', async () => {
    const fetchMock = mock(
        async () => new Response(JSON.stringify({ status: 'pending' }), { status: 200 }),
    )
    const sleepMock = mock(async (_ms: number) => {})
    const nowValues = [0, 0, 50, 120]
    let index = 0
    const originalNow = Date.now
    Date.now = () => nowValues[Math.min(index++, nowValues.length - 1)] ?? 120

    try {
        await expect(
            pollIntentStatus(
                'request-1',
                {
                    timeoutMs: 100,
                    intervals: [{ untilMs: 1_000, everyMs: 10 }],
                },
                {
                    fetch: fetchMock as typeof fetch,
                    sleep: sleepMock,
                    baseUrl: 'https://api.relay.link',
                },
            ),
        ).rejects.toMatchObject({
            name: 'RelayLinkError',
            code: 'TIMEOUT',
        } satisfies Partial<RelayLinkError>)
    } finally {
        Date.now = originalNow
    }
})
