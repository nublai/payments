import { createServer, type Server } from 'node:http'
import { expect, mock, test } from 'bun:test'
import { zeroAddress, type Address, type Hex } from 'viem'
import { hashTypedData } from 'viem/utils'
import { INTENT_TYPES, type Call } from '@nubl/relayer-client'
import { executeAccountSend } from '../src/lib/account-send'
import { executeSignedCalls } from '../src/lib/execute-calls'
import { estimateCombinedGasCeiling, localCombinedGasCeiling } from '../src/lib/gas-ceiling'
import { getEnvRelayerUrl, getUsdcAddressByChainId } from '../src/lib/network-config'
import { resolveOrchestratorAddress } from '../src/lib/orchestrator-address'

const EOA = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const SIG =
    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b' as Hex
const CALLS: Call[] = [{ target: TARGET, value: 0n, data: '0x1234' }]
const NOW = 1_700_000_000n
const EXPIRY = NOW + 60n
const GAS_CEILING = 1_000_000n
const PAID_FEE_CAP = 5_000_000n

type PrepareInput = {
    from: Address
    calls: Call[]
    nonce: bigint
    expiry?: bigint
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: bigint
}

function preparedQuote(
    input: PrepareInput,
    paymentAmount: unknown,
    chainId: number,
    capOverride?: bigint,
    orchestrator: Address = ORCHESTRATOR,
) {
    const cap = capOverride ?? input.paymentMaxAmount ?? 0n
    const payer = input.payer ?? zeroAddress
    const paymentToken = input.paymentToken ?? zeroAddress
    const expiry = input.expiry ?? EXPIRY
    const messageCalls = input.calls.map((call) => ({
        to: call.target,
        value: call.value,
        data: call.data ?? '0x',
    }))
    const message = {
        multichain: false,
        eoa: input.from,
        calls: messageCalls,
        nonce: input.nonce,
        payer,
        paymentToken,
        paymentMaxAmount: cap,
        combinedGas: 50_000n,
        encodedPreCalls: [] as Hex[],
        encodedFundTransfers: [] as Hex[],
        settler: zeroAddress,
        expiry,
    }
    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId,
        verifyingContract: orchestrator,
    }
    const quote: Record<string, unknown> = {
        chainId: `0x${chainId.toString(16)}`,
        orchestrator,
        intent: {
            eoa: input.from,
            calls: messageCalls.map((call) => ({
                to: call.to,
                value: call.value.toString(),
                data: call.data,
            })),
            nonce: input.nonce.toString(),
            combinedGas: message.combinedGas.toString(),
            expiry: expiry.toString(),
            payer,
            paymentToken,
            paymentMaxAmount: cap.toString(),
            settler: zeroAddress,
        },
        extraPayment: '0x0',
        ethPrice: '0x0',
        paymentTokenDecimals: 6,
        txGas: 1,
        nativeFeeEstimate: { maxFeePerGas: 1, maxPriorityFeePerGas: 1 },
        feeTokenDeficit: '0x0',
        assetDeficits: [],
    }
    if (paymentAmount !== undefined) quote.paymentAmount = paymentAmount
    return {
        digest: hashTypedData({
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent',
            message,
        }),
        typedData: {
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message,
        },
        context: {
            quote: {
                quotes: [quote],
                signature: '0x' as Hex,
                ttl: 2_000_000_000,
            },
        },
    }
}

function signingHarness(
    prepare: (input: PrepareInput) => ReturnType<typeof preparedQuote>,
) {
    const signTypedData = mock(async () => SIG)
    const sendPreparedCalls = mock(async () => ({ id: 'bundle-1' }))
    const prepareCalls = mock(async (input: PrepareInput) => prepare(input))
    return {
        signTypedData,
        sendPreparedCalls,
        prepareCalls,
        deps: {
            prepareCalls,
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
    }
}

const prodParams = {
    from: EOA,
    calls: CALLS,
    nonce: 7n,
    signerPrivateKey: `0x${'11'.repeat(32)}` as Hex,
    chainId: 8453,
    env: 'prod' as const,
    verifyingContract: ORCHESTRATOR,
    expiry: EXPIRY,
    now: NOW,
    combinedGasCeiling: GAS_CEILING,
}

function signedCap(signTypedData: ReturnType<typeof mock>): bigint {
    const typed = signTypedData.mock.calls[0]?.[0]?.typedData as {
        message: { paymentMaxAmount: bigint }
    }
    return typed.message.paymentMaxAmount
}

test('off-local quote of 0 is refused and does not sign the 5 USDC ceiling', async () => {
    const { deps, signTypedData, sendPreparedCalls } = signingHarness((input) =>
        preparedQuote(input, '0', 8453),
    )
    await expect(executeSignedCalls(deps, prodParams)).rejects.toThrow(
        /off-local quote payment is zero/,
    )
    expect(signTypedData).not.toHaveBeenCalled()
    expect(sendPreparedCalls).not.toHaveBeenCalled()
})

test('off-local omitted quote payment is refused', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, undefined, 8453))
    await expect(executeSignedCalls(deps, prodParams)).rejects.toThrow(
        /quote payment amount is missing/,
    )
    expect(signTypedData).not.toHaveBeenCalled()
})

test('off-local non-numeric quote payment is refused', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, 'nope', 8453))
    await expect(executeSignedCalls(deps, prodParams)).rejects.toThrow(
        /quote payment amount is not numeric/,
    )
    expect(signTypedData).not.toHaveBeenCalled()
})

test('quote of 1 signs paymentMaxAmount 1001 and discloses that cap', async () => {
    const { deps, signTypedData, prepareCalls } = signingHarness((input) =>
        preparedQuote(input, '1', 8453),
    )
    const result = await executeSignedCalls(deps, prodParams)
    expect(prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
    expect(prepareCalls.mock.calls[1]?.[0]?.paymentMaxAmount).toBe(1001n)
    expect(signedCap(signTypedData)).toBe(1001n)
    expect(result.feeCap).toEqual({
        token: BASE_USDC,
        symbol: 'USDC',
        amountUsdc: '0.001001',
        expiresIn: '1h',
    })
})

test('an honest quote signs the quote plus 5 percent', async () => {
    const { deps, signTypedData, prepareCalls } = signingHarness((input) =>
        preparedQuote(input, '250000', 8453),
    )
    const result = await executeSignedCalls(deps, prodParams)
    expect(prepareCalls.mock.calls[1]?.[0]?.paymentMaxAmount).toBe(262500n)
    expect(signedCap(signTypedData)).toBe(262500n)
    expect(result.feeCap.amountUsdc).toBe('0.2625')
    expect(result.feeCap.expiresIn).toBe('1h')
})

test('a quote whose margin lands on the 5 USDC ceiling is signed at that ceiling', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '4761904', 8453))
    await executeSignedCalls(deps, prodParams)
    expect(signedCap(signTypedData)).toBe(PAID_FEE_CAP)
})

test('a quote whose margin exceeds the 5 USDC ceiling is refused', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '4761905', 8453))
    await expect(executeSignedCalls(deps, prodParams)).rejects.toThrow(/payment amount exceeds fee cap/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('a quote of 5 USDC is refused because the margin exceeds the ceiling', async () => {
    const { deps, signTypedData } = signingHarness((input) =>
        preparedQuote(input, PAID_FEE_CAP.toString(), 8453),
    )
    await expect(executeSignedCalls(deps, prodParams)).rejects.toThrow(/payment amount exceeds fee cap/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('a relayer typed-data cap other than quote plus margin is refused', async () => {
    const { deps, signTypedData } = signingHarness((input) =>
        preparedQuote(input, '1', 8453, PAID_FEE_CAP),
    )
    await expect(executeSignedCalls(deps, prodParams)).rejects.toThrow(/fee cap does not match/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('a second prepare that raises the quote is refused', async () => {
    let calls = 0
    const { deps, signTypedData } = signingHarness((input) => {
        calls += 1
        return preparedQuote(input, calls === 1 ? '1' : '250000', 8453)
    })
    await expect(executeSignedCalls(deps, prodParams)).rejects.toThrow(/fee cap does not match the quote/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('an explicit 5 USDC ceiling still signs the quote plus margin', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '1', 8453))
    await executeSignedCalls(deps, { ...prodParams, paymentMaxAmount: PAID_FEE_CAP })
    expect(signedCap(signTypedData)).toBe(1001n)
})

test('omitting the cap while passing payer and token still signs the quote plus margin', async () => {
    const { deps, signTypedData, prepareCalls } = signingHarness((input) =>
        preparedQuote(input, '1', 8453),
    )
    const result = await executeSignedCalls(deps, {
        ...prodParams,
        payer: EOA,
        paymentToken: BASE_USDC,
    })
    expect(prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
    expect(signedCap(signTypedData)).toBe(1001n)
    expect(result.feeCap).toEqual({
        token: BASE_USDC,
        symbol: 'USDC',
        amountUsdc: '0.001001',
        expiresIn: '1h',
    })
})

test('a local zero quote signs cap 0 with a zero payer and says so', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '0', 31337))
    const result = await executeSignedCalls(deps, {
        ...prodParams,
        chainId: 31337,
        env: 'dev',
    })
    expect(signedCap(signTypedData)).toBe(0n)
    const signed = signTypedData.mock.calls[0]?.[0]?.typedData as {
        message: { payer: Address; paymentToken: Address }
    }
    expect(signed.message.payer).toBe(zeroAddress)
    expect(signed.message.paymentToken).toBe(zeroAddress)
    expect(result.feeCap).toEqual({
        token: zeroAddress,
        symbol: 'none',
        amountUsdc: '0',
        expiresIn: '1h',
    })
})

test('prod send returns the fee cap for human and json output', async () => {
    const signTypedData = mock(async () => SIG)
    const result = await executeAccountSend(
        {
            env: 'prod',
            amount: '1',
            recipient: '0x2222222222222222222222222222222222222222',
            chain: 'polygon',
            password: 'pw',
            keystorePath: '/tmp/alice.json',
        },
        {
            readKeystoreBundle: mock(
                async () =>
                    ({
                        format: 'split',
                        rootPath: '/tmp/alice.json',
                        sessionPath: '/tmp/sessions/default.json',
                        root: { addresses: { root: EOA, delegated: EOA } },
                        session: {
                            addresses: { session: '0x3333333333333333333333333333333333333333' },
                        },
                    }) as never,
            ),
            decryptSessionKeystore: mock(async () => ({
                sessionPrivateKey:
                    '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7',
            })),
            resolveAddressOrEnsInput: mock(async () => ({
                address: '0x2222222222222222222222222222222222222222' as Address,
                ens: null,
            })),
            hasLegacyRecipientAlias: mock(async () => false),
            readNonce: mock(async () => 2n),
            prepareCalls: mock(
                async (
                    input: PrepareInput & { network: { env: 'prod'; chainId: number } },
                ) =>
                    preparedQuote(
                        input,
                        '250000',
                        input.network.chainId,
                        undefined,
                        resolveOrchestratorAddress(input.network.env, input.network.chainId),
                    ),
            ),
            signTypedData,
            sendPreparedCalls: mock(async () => ({ id: 'bundle-1' })),
            waitForBundle: mock(async () => ({
                success: true,
                id: 'bundle-1',
                status: 'confirmed' as const,
                statusCode: 200,
                receipt: {
                    transactionHash:
                        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    blockNumber: '1',
                    gasUsed: '1',
                    status: 'success' as const,
                },
            })) as never,
        } as never,
    )
    expect(result.feeCap).toEqual({
        token: POLYGON_USDC,
        symbol: 'USDC',
        amountUsdc: '0.2625',
        expiresIn: '1h',
    })
    expect(signedCap(signTypedData)).toBe(262500n)
})

test('dev cleartext is refused for a published orchestrator and allowed for local', () => {
    const previous = process.env.RELAYER_URL_DEV
    process.env.RELAYER_URL_DEV = 'http://relayer.example'
    try {
        expect(() => getEnvRelayerUrl('dev', 84532)).toThrow(/https/)
        expect(() => getEnvRelayerUrl('dev', 8453)).toThrow(/https/)
        expect(getEnvRelayerUrl('dev', 31337)).toBe('http://relayer.example')
        expect(getEnvRelayerUrl('dev', 41337)).toBe('http://relayer.example')
        process.env.RELAYER_URL_DEV = 'http://127.0.0.1:8787'
        expect(getEnvRelayerUrl('dev', 84532)).toBe('http://127.0.0.1:8787')
        process.env.RELAYER_URL_DEV = 'https://relayer.example'
        expect(getEnvRelayerUrl('dev', 84532)).toBe('https://relayer.example')
    } finally {
        if (previous === undefined) delete process.env.RELAYER_URL_DEV
        else process.env.RELAYER_URL_DEV = previous
    }
})

test('USDC is known for Arbitrum and Base Sepolia', () => {
    expect(getUsdcAddressByChainId(42161)).toBe(ARBITRUM_USDC)
    expect(getUsdcAddressByChainId(84532)).toBe(BASE_SEPOLIA_USDC)
})

function listen(handler: (body: string) => string): Promise<{ server: Server; url: string }> {
    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk as Buffer))
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(handler(body))
        })
    })
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as { port: number }).port
            resolve({ server, url: `http://127.0.0.1:${port}` })
        })
    })
}

function rpcResult(body: string, gas: bigint): string {
    const parsed = JSON.parse(body) as { id?: number; method?: string }
    const method = parsed.method
    const result = method === 'eth_chainId' ? '0x2105' : `0x${gas.toString(16)}`
    return JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result })
}

test('a colluding RPC cannot raise the gas ceiling above twice the local formula', async () => {
    const calls = [{ target: TARGET, value: 0n, data: '0x' as Hex }]
    const local = localCombinedGasCeiling(calls)
    const { server, url } = await listen((body) => rpcResult(body, 100_000_000n))
    try {
        const ceiling = await estimateCombinedGasCeiling({
            rpcUrl: url,
            chainId: 8453,
            from: EOA,
            calls,
        })
        expect(ceiling).toBe(local * 2n)
        expect(ceiling).toBeLessThan(800_500_000n)
    } finally {
        server.close()
    }
})

test('an RPC estimate within twice the local formula is kept', async () => {
    const calls = [{ target: TARGET, value: 0n, data: '0x' as Hex }]
    const local = localCombinedGasCeiling(calls)
    const estimated = 200_000n
    const fromRpc = estimated * 8n + 500_000n
    const { server, url } = await listen((body) => rpcResult(body, estimated))
    try {
        const ceiling = await estimateCombinedGasCeiling({
            rpcUrl: url,
            chainId: 8453,
            from: EOA,
            calls,
        })
        expect(fromRpc > local && fromRpc < local * 2n).toBe(true)
        expect(ceiling).toBe(fromRpc)
    } finally {
        server.close()
    }
})
