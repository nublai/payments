import { createServer } from 'node:http'
import { expect, mock, test } from 'bun:test'
import { createPublicClient, http, zeroAddress, type Address, type Hex } from 'viem'
import { hashTypedData } from 'viem/utils'
import {
    INTENT_TYPES,
    createJsonRpcTransport,
    getChain,
    relayerActions,
    signPreparedCalls,
    type Call,
} from '@nubl/relayer-client'
import { executeSignedCalls } from '../src/lib/execute-calls'
import { getEnvRelayerUrl } from '../src/lib/network-config'

const EOA = '0x1111111111111111111111111111111111111111' as Address

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

const TARGET = '0x2222222222222222222222222222222222222222' as Address

const ATTACKER = '0x3333333333333333333333333333333333333333' as Address

const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address

const SIG =
    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as Hex

const REQUESTED: Call[] = [{ target: TARGET, value: 1n, data: '0x1234' }]

const NOW = 1_700_000_000n

const EXPIRY = NOW + 60n

const GAS_CEILING = 1_000_000n

type IntentCall = { to: Address; value: bigint; data: Hex }

function makePrepared(messageCalls: IntentCall[], nonce = 7n, paymentMaxAmount = 2000n) {
    const message = {
        multichain: false,
        eoa: EOA,
        calls: messageCalls,
        nonce,
        payer: EOA,
        paymentToken: BASE_USDC,
        paymentMaxAmount,
        combinedGas: 50_000n,
        encodedPreCalls: [] as Hex[],
        encodedFundTransfers: [] as Hex[],
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
        message,
    })

    return {
        digest,
        typedData: {
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message,
        },
        context: {
            quote: {
                quotes: [
                    {
                        chainId: '0x2105',
                        orchestrator: ORCHESTRATOR,
                        intent: {
                            eoa: EOA,
                            calls: messageCalls.map((call) => ({
                                to: call.to,
                                value: call.value.toString(),
                                data: call.data,
                            })),
                            nonce: nonce.toString(),
                            combinedGas: message.combinedGas.toString(),
                            expiry: message.expiry.toString(),
                            payer: EOA,
                            paymentToken: BASE_USDC,
                            paymentMaxAmount: paymentMaxAmount.toString(),
                            settler: zeroAddress,
                        },
                        extraPayment: '0x0',
                        ethPrice: '0x0',
                        paymentTokenDecimals: 6,
                        txGas: 1,
                        nativeFeeEstimate: { maxFeePerGas: 1, maxPriorityFeePerGas: 1 },
                        paymentAmount: '1000',
                        feeTokenDeficit: '0x0',
                        assetDeficits: [],
                    },
                ],
                signature: '0x' as Hex,
                ttl: 2_000_000_000,
            },
        },
    }
}

const expected = {
    from: EOA,
    calls: REQUESTED,
    chainId: 8453,
    verifyingContract: ORCHESTRATOR,
    nonce: 7n,
    payer: EOA,
    paymentToken: BASE_USDC,
    paymentMaxAmount: 2000n,
    expiry: EXPIRY,
    now: NOW,
    combinedGasCeiling: GAS_CEILING,
}

function rehash(prepared: ReturnType<typeof makePrepared>) {
    prepared.digest = hashTypedData({
        domain: {
            name: prepared.typedData.domain.name,
            version: prepared.typedData.domain.version,
            chainId: prepared.typedData.domain.chainId,
            verifyingContract: prepared.typedData.domain.verifyingContract,
        },
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message: prepared.typedData.message,
    })
}

function signingDeps(prepared: ReturnType<typeof makePrepared>) {
    const signTypedData = mock(async () => SIG)
    const sendPreparedCalls = mock(async () => ({ id: 'bundle-1' }))

    return {
        signTypedData,
        sendPreparedCalls,
        deps: {
            prepareCalls: async () => prepared,
            signTypedData,
            sendPreparedCalls,
            waitForBundle: async () => {
                throw new Error('waitForBundle should not run')
            },
        },
    }
}

async function expectWalletRefuses(
    prepared: ReturnType<typeof makePrepared>,
    pattern: RegExp,
    overrides?: { expiry?: bigint; now?: bigint },
) {
    const { signTypedData, sendPreparedCalls, deps } = signingDeps(prepared)
    await expect(
        executeSignedCalls(deps, {
            from: EOA,
            calls: REQUESTED,
            nonce: 7n,
            signerPrivateKey: `0x${'11'.repeat(32)}` as Hex,
            chainId: 8453,
            env: 'prod',
            verifyingContract: ORCHESTRATOR,
            payer: EOA,
            paymentToken: BASE_USDC,
            paymentMaxAmount: 2000n,
            expiry: overrides?.expiry ?? EXPIRY,
            now: overrides?.now ?? NOW,
            combinedGasCeiling: GAS_CEILING,
        }),
    ).rejects.toThrow(pattern)
    expect(signTypedData).not.toHaveBeenCalled()
    expect(sendPreparedCalls).not.toHaveBeenCalled()
}

async function expectHelperRefuses(prepared: ReturnType<typeof makePrepared>, pattern: RegExp) {
    const signTypedData = mock(async () => SIG)
    await expect(
        signPreparedCalls({
            prepared: prepared as never,
            expected,
            signer: { type: 'typedData', signTypedData },
        }),
    ).rejects.toThrow(pattern)
    expect(signTypedData).not.toHaveBeenCalled()
}

test('executeSignedCalls signs when the prepared intent matches the request', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 1n, data: '0x1234' }])
    const signTypedData = mock(async () => SIG)
    const sendPreparedCalls = mock(async () => ({ id: 'bundle-1' }))

    const result = await executeSignedCalls(
        {
            prepareCalls: async () => prepared,
            signTypedData,
            sendPreparedCalls,
            waitForBundle: async () =>
                ({
                    id: 'bundle-1',
                    status: 'confirmed',
                    statusCode: 200,
                    success: true,
                }) as never,
        },
        {
            from: EOA,
            calls: REQUESTED,
            nonce: 7n,
            signerPrivateKey: `0x${'11'.repeat(32)}` as Hex,
            chainId: 8453,
            env: 'prod',
            verifyingContract: ORCHESTRATOR,
            payer: EOA,
            paymentToken: BASE_USDC,
            paymentMaxAmount: 2000n,
            expiry: EXPIRY,
            now: NOW,
            combinedGasCeiling: GAS_CEILING,
        },
    )

    expect(signTypedData).toHaveBeenCalled()
    expect(sendPreparedCalls).toHaveBeenCalled()
    expect(result.id).toBe('bundle-1')
})

test('executeSignedCalls refuses a zero payer and token off local instead of signing them', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 1n, data: '0x1234' }])
    const signTypedData = mock(async () => SIG)
    await expect(
        executeSignedCalls(
            {
                prepareCalls: async () => prepared,
                signTypedData,
                sendPreparedCalls: async () => ({ id: 'bundle-1' }),
                waitForBundle: async () => {
                    throw new Error('waitForBundle should not run')
                },
            },
            {
                from: EOA,
                calls: REQUESTED,
                nonce: 7n,
                signerPrivateKey: `0x${'11'.repeat(32)}` as Hex,
                chainId: 8453,
                env: 'prod',
                verifyingContract: ORCHESTRATOR,
                payer: zeroAddress,
                paymentToken: zeroAddress,
                paymentMaxAmount: 2000n,
                expiry: EXPIRY,
                now: NOW,
                combinedGasCeiling: GAS_CEILING,
            },
        ),
    ).rejects.toThrow(/zero address/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('executeSignedCalls and signPreparedCalls refuse a substituted call target', async () => {
    const prepared = makePrepared([{ to: ATTACKER, value: 1n, data: '0x1234' }])
    await expectWalletRefuses(prepared, /call target does not match/)
    await expectHelperRefuses(prepared, /call target does not match/)
})

test('executeSignedCalls and signPreparedCalls refuse a substituted call value', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 2n, data: '0x1234' }])
    await expectWalletRefuses(prepared, /call value does not match/)
    await expectHelperRefuses(prepared, /call value does not match/)
})

test('executeSignedCalls and signPreparedCalls refuse substituted calldata', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 1n, data: '0xdead' }])
    await expectWalletRefuses(prepared, /call data does not match/)
    await expectHelperRefuses(prepared, /call data does not match/)
})

test('executeSignedCalls and signPreparedCalls refuse a substituted nonce', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 1n, data: '0x1234' }], 8n)
    await expectWalletRefuses(prepared, /nonce does not match/)
    await expectHelperRefuses(prepared, /nonce does not match/)
})

test('executeSignedCalls and signPreparedCalls refuse a substituted fee cap', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 1n, data: '0x1234' }], 7n, 999_999n)
    await expectWalletRefuses(prepared, /fee cap does not match/)
    await expectHelperRefuses(prepared, /fee cap does not match/)
})

test('executeSignedCalls refuses a quote whose target differs from the signed calls', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 1n, data: '0x1234' }])
    prepared.context.quote.quotes[0].intent.calls[0].to = ATTACKER
    await expectWalletRefuses(prepared, /quote does not match/)
    await expectHelperRefuses(prepared, /quote does not match/)
})

test('getEnvRelayerUrl refuses plain http for a non-loopback host off dev', () => {
    const previousProd = process.env.RELAYER_URL_PROD
    const previousStage = process.env.RELAYER_URL_STAGE
    const previousDev = process.env.RELAYER_URL_DEV
    process.env.RELAYER_URL_PROD = 'http://relayer.example'
    process.env.RELAYER_URL_STAGE = 'http://relayer.example'
    process.env.RELAYER_URL_DEV = 'http://relayer.example'

    try {
        expect(() => getEnvRelayerUrl('prod')).toThrow(/https/)
        expect(() => getEnvRelayerUrl('stage')).toThrow(/https/)
        expect(() => getEnvRelayerUrl('dev')).toThrow(/https/)
        expect(getEnvRelayerUrl('dev', 31337)).toBe('http://relayer.example')
        process.env.RELAYER_URL_PROD = 'http://127.0.0.1:8787'
        expect(getEnvRelayerUrl('prod')).toBe('http://127.0.0.1:8787')
    } finally {
        if (previousProd === undefined) delete process.env.RELAYER_URL_PROD
        else process.env.RELAYER_URL_PROD = previousProd

        if (previousStage === undefined) delete process.env.RELAYER_URL_STAGE
        else process.env.RELAYER_URL_STAGE = previousStage

        if (previousDev === undefined) delete process.env.RELAYER_URL_DEV
        else process.env.RELAYER_URL_DEV = previousDev
    }
})

test('createJsonRpcTransport refuses plain http for a non-loopback host', () => {
    expect(() => createJsonRpcTransport('http://relayer.example')).toThrow(/https/)
    expect(() => createJsonRpcTransport('http://127.0.0.1:8787')).not.toThrow()
    expect(() =>
        createJsonRpcTransport('http://relayer.example', { allowInsecureHttp: true }),
    ).not.toThrow()
})

test('executeSignedCalls refuses expiry 0, a past expiry, and an expiry past the ttl', async () => {
    const calls = [{ to: TARGET, value: 1n, data: '0x1234' as Hex }]
    const unset = makePrepared(calls)
    unset.typedData.message.expiry = 0n
    unset.context.quote.quotes[0].intent.expiry = '0'
    rehash(unset)
    await expectWalletRefuses(unset, /expiry is unset/, { expiry: 0n })

    const past = makePrepared(calls)
    past.typedData.message.expiry = NOW
    past.context.quote.quotes[0].intent.expiry = NOW.toString()
    rehash(past)
    await expectWalletRefuses(past, /expiry is in the past/, { expiry: NOW, now: NOW })

    const tooFar = makePrepared(calls)
    tooFar.typedData.message.expiry = NOW + 3601n
    tooFar.context.quote.quotes[0].intent.expiry = (NOW + 3601n).toString()
    rehash(tooFar)
    await expectWalletRefuses(tooFar, /expiry exceeds the wallet ttl/, {
        expiry: NOW + 3601n,
        now: NOW,
    })
})

test('executeSignedCalls refuses a combined gas above the wallet ceiling', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 1n, data: '0x1234' }])
    const huge = 2n ** 96n - 1n
    prepared.typedData.message.combinedGas = huge
    prepared.context.quote.quotes[0].intent.combinedGas = huge.toString()
    rehash(prepared)
    await expectWalletRefuses(prepared, /combined gas exceeds the wallet ceiling/)
})

test('executeSignedCalls refuses a quote payment above the wallet fee cap', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 1n, data: '0x1234' }])
    prepared.context.quote.quotes[0].paymentAmount = '1001'
    await expectWalletRefuses(prepared, /payment amount exceeds fee cap/)
})

test('executeSignedCalls signs the rebuilt typed data when the relayer adds a domain salt', async () => {
    const prepared = makePrepared([{ to: TARGET, value: 1n, data: '0x1234' }])
    prepared.typedData.domain = {
        ...prepared.typedData.domain,
        salt: `0x${'11'.repeat(32)}`,
    } as typeof prepared.typedData.domain
    const signTypedData = mock(async () => SIG)
    await executeSignedCalls(
        {
            prepareCalls: async () => prepared,
            signTypedData,
            sendPreparedCalls: async () => ({ id: 'bundle-1' }),
            waitForBundle: async () =>
                ({ id: 'bundle-1', status: 'confirmed', statusCode: 200, success: true }) as never,
        },
        {
            from: EOA,
            calls: REQUESTED,
            nonce: 7n,
            signerPrivateKey: `0x${'11'.repeat(32)}` as Hex,
            chainId: 8453,
            env: 'prod',
            verifyingContract: ORCHESTRATOR,
            payer: EOA,
            paymentToken: BASE_USDC,
            paymentMaxAmount: 2000n,
            expiry: EXPIRY,
            now: NOW,
            combinedGasCeiling: GAS_CEILING,
        },
    )
    const signed = signTypedData.mock.calls[0]?.[0]?.typedData as { domain: { salt?: string } }
    expect(signed.domain.salt).toBeUndefined()
    expect(signTypedData).toHaveBeenCalled()

    const helperSign = mock(async () => SIG)
    await signPreparedCalls({
        prepared: prepared as never,
        expected,
        signer: { type: 'typedData', signTypedData: helperSign },
    })
    const helperSigned = helperSign.mock.calls[0]?.[0] as { domain: { salt?: string } }
    expect(helperSigned.domain.salt).toBeUndefined()
})

test('createJsonRpcTransport does not follow a relayer redirect', async () => {
    let hopped = false

    const hopper = createServer((_req, res) => {
        hopped = true
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    })

    await new Promise<void>((resolve) => hopper.listen(0, '127.0.0.1', () => resolve()))
    const hopPort = (hopper.address() as { port: number }).port

    const redirector = createServer((_req, res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${hopPort}/` })
        res.end()
    })

    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', () => resolve()))
    const port = (redirector.address() as { port: number }).port

    try {
        const transport = createJsonRpcTransport(`http://127.0.0.1:${port}`)
        await expect(transport.request('wallet_health')).rejects.toThrow(/redirect/i)
        expect(hopped).toBe(false)
    } finally {
        redirector.close()
        hopper.close()
    }
})

test('getCapabilities surfaces the https refusal', async () => {
    const client = createPublicClient({
        chain: getChain(8453, 'http://127.0.0.1:8545'),
        transport: http('http://127.0.0.1:8545'),
    }).extend(
        relayerActions({
            relayerUrl: 'http://relayer.example',
            chainId: 8453,
        }),
    )

    await expect(client.getCapabilities()).rejects.toThrow(/https/)

    const devClient = createPublicClient({
        chain: getChain(31337, 'http://127.0.0.1:8545'),
        transport: http('http://127.0.0.1:8545'),
    }).extend(
        relayerActions({
            relayerUrl: 'http://127.0.0.1:9',
            chainId: 31337,
            allowInsecureHttp: true,
        }),
    )

    const devResult = await devClient.getCapabilities()
    expect(devResult.success).toBe(false)
    expect(devResult.error ?? '').not.toMatch(/https/)
})
