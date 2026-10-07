import { expect, mock, test } from 'bun:test'
import { zeroAddress, type Address, type Hex } from 'viem'
import { hashTypedData } from 'viem/utils'
import {
    INTENT_TYPES,
    createJsonRpcTransport,
    signPreparedCalls,
    type Call,
} from '@nubl/relayer-client'
import { executeSignedCalls } from '../src/lib/execute-calls'
import { getEnvRelayerUrl } from '../src/lib/network-config'

const EOA = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const ATTACKER = '0x3333333333333333333333333333333333333333' as Address
const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address
const SIG =
    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as Hex

const REQUESTED: Call[] = [{ target: TARGET, value: 1n, data: '0x1234' }]

type IntentCall = { to: Address; value: bigint; data: Hex }

function makePrepared(messageCalls: IntentCall[], nonce = 7n, paymentMaxAmount = 1000n) {
    const message = {
        multichain: false,
        eoa: EOA,
        calls: messageCalls,
        nonce,
        payer: zeroAddress,
        paymentToken: zeroAddress,
        paymentMaxAmount,
        combinedGas: 50_000n,
        encodedPreCalls: [] as Hex[],
        encodedFundTransfers: [] as Hex[],
        settler: zeroAddress,
        expiry: 1_900_000_000n,
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
                            payer: zeroAddress,
                            paymentToken: zeroAddress,
                            paymentMaxAmount: paymentMaxAmount.toString(),
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
    paymentMaxAmount: 1000n,
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

async function expectWalletRefuses(prepared: ReturnType<typeof makePrepared>, pattern: RegExp) {
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
            paymentMaxAmount: 1000n,
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
            paymentMaxAmount: 1000n,
        },
    )
    expect(signTypedData).toHaveBeenCalled()
    expect(sendPreparedCalls).toHaveBeenCalled()
    expect(result.id).toBe('bundle-1')
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
        expect(getEnvRelayerUrl('dev')).toBe('http://relayer.example')
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
