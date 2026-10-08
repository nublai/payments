import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { zeroAddress, type Address } from 'viem'
import { hashTypedData } from 'viem/utils'
import { INTENT_TYPES, type Call, type PrepareCallsResponse } from '@nubl/relayer-client'
import { executeAccountSend, type AccountSendDeps } from '../src/lib/account-send'
import { executeSignedCalls, type ExecuteSignedCallsDeps } from '../src/lib/execute-calls'
import { discloseFeeCap } from '../src/lib/intent-payment'
import { estimateCombinedGasCeiling, localCombinedGasCeiling } from '../src/lib/gas-ceiling'
import { getEnvRelayerUrl, getUsdcAddressByChainId } from '../src/lib/network-config'
import { resolveOrchestratorAddress } from '../src/lib/orchestrator-address'
import { installFormerProdDeployments } from './helpers/former-deployment-env'
import { confirmedBundle } from './helpers/bundle-status'
import { boundPort } from './helpers/bound-port'
import { emptyHex, repeatedHex } from './helpers/hex'
import { testKeystoreBundle } from './helpers/keystore-bundle'
import { parseJson } from './helpers/parse-json'

let restoreFormerProdDeployments = () => {}

beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})

afterAll(() => {
    restoreFormerProdDeployments()
})

const EOA = '0x1111111111111111111111111111111111111111'

const TARGET = '0x2222222222222222222222222222222222222222'

const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8'

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'

const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

const SIG =
    '0x111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111b'

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

type Quote = PrepareCallsResponse['context']['quote']['quotes'][number]

type SignTypedDataInput = Parameters<ExecuteSignedCallsDeps['signTypedData']>[0]

function preparedQuote(
    input: PrepareInput,
    paymentAmount: string | undefined,
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
        data: call.data ?? '0x' }))

    const message = {
        multichain: false,
        eoa: input.from,
        calls: messageCalls,
        nonce: input.nonce,
        payer,
        paymentToken,
        paymentMaxAmount: cap,
        combinedGas: 50_000n,
        encodedPreCalls: emptyHex(),
        encodedFundTransfers: emptyHex(),
        settler: zeroAddress,
        expiry }

    const domain = {
        name: 'Orchestrator',
        version: '0.5.5',
        chainId,
        verifyingContract: orchestrator }

    const quoteWithoutPayment: Omit<Quote, 'paymentAmount'> = {
        chainId: `0x${chainId.toString(16)}`,
        orchestrator,
        intent: {
            eoa: input.from,
            calls: messageCalls.map((call) => ({
                to: call.to,
                value: call.value.toString(),
                data: call.data })),
            nonce: input.nonce.toString(),
            combinedGas: message.combinedGas.toString(),
            expiry: expiry.toString(),
            payer,
            paymentToken,
            paymentMaxAmount: cap.toString(),
            settler: zeroAddress },
        extraPayment: '0x0',
        ethPrice: '0x0',
        paymentTokenDecimals: 6,
        txGas: 1,
        nativeFeeEstimate: { maxFeePerGas: 1, maxPriorityFeePerGas: 1 },
        feeTokenDeficit: '0x0',
        assetDeficits: [] }

    // SAFETY: an undefined paymentAmount deliberately models a malformed relayer quote that executeSignedCalls must refuse at runtime.
    const quote: Quote =
        paymentAmount === undefined
            ? (quoteWithoutPayment as Quote)
            : { ...quoteWithoutPayment, paymentAmount }

    return {
        digest: hashTypedData({
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent',
            message }),
        typedData: {
            domain,
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message },
        context: {
            quote: {
                quotes: [quote],
                signature: '0x',
                ttl: 2_000_000_000 } } }
}

function signingHarness(
    prepare: (input: PrepareInput) => ReturnType<typeof preparedQuote>,
) {
    const signTypedData = mock(async (_input: SignTypedDataInput) => SIG)
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
            waitForBundle: async () => confirmedBundle() } }
}

const prodParams = {
    from: EOA,
    calls: CALLS,
    nonce: 7n,
    signerPrivateKey: repeatedHex('11', 32),
    chainId: 8453,
    env: 'prod' as const,
    verifyingContract: ORCHESTRATOR,
    expiry: EXPIRY,
    now: NOW,
    combinedGasCeiling: GAS_CEILING }

function signedCap(signTypedData: ReturnType<typeof mock>): bigint {
    const typed: { message: { paymentMaxAmount: bigint } } =
        signTypedData.mock.calls[0]?.[0]?.typedData

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
        expiresIn: '1h' })
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

test('an over-ceiling caller cap is clamped to 5 USDC', async () => {
    const { deps, signTypedData, prepareCalls } = signingHarness((input) =>
        preparedQuote(input, '1', 8453),
    )

    await executeSignedCalls(deps, {
        ...prodParams,
        paymentMaxAmount: 100_000_000n,
        payer: EOA,
        paymentToken: BASE_USDC })
    expect(prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
    expect(signedCap(signTypedData)).toBe(1001n)

    const signed: { message: { payer: Address; paymentToken: Address } } =
        signTypedData.mock.calls[0]?.[0]?.typedData

    expect(signed.message.payer).toBe(EOA)
    expect(signed.message.paymentToken).toBe(BASE_USDC)
})

test('a 50 USDC quote cannot be signed by raising the caller cap', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '50000000', 8453))
    await expect(
        executeSignedCalls(deps, {
            ...prodParams,
            paymentMaxAmount: 100_000_000n,
            payer: EOA,
            paymentToken: BASE_USDC }),
    ).rejects.toThrow(/payment amount exceeds fee cap/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('a caller cap without payer or token is refused', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '1', 8453))
    await expect(
        executeSignedCalls(deps, { ...prodParams, paymentMaxAmount: 1001n }),
    ).rejects.toThrow(/payer and paymentToken/)
    await expect(
        executeSignedCalls(deps, { ...prodParams, paymentMaxAmount: 1001n, payer: EOA }),
    ).rejects.toThrow(/payer and paymentToken/)
    await expect(
        executeSignedCalls(deps, {
            ...prodParams,
            paymentMaxAmount: 1001n,
            paymentToken: BASE_USDC }),
    ).rejects.toThrow(/payer and paymentToken/)
    expect(signTypedData).not.toHaveBeenCalled()
})

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'

const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'

test('an explicit zero payer and token is refused off local', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '1', 8453))
    await expect(
        executeSignedCalls(deps, {
            ...prodParams,
            paymentMaxAmount: 100_000_000n,
            payer: zeroAddress,
            paymentToken: zeroAddress }),
    ).rejects.toThrow(/zero address/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('a payer or token without a cap is refused off local', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '1', 8453))
    await expect(
        executeSignedCalls(deps, { ...prodParams, payer: zeroAddress }),
    ).rejects.toThrow(/payer and paymentToken/)
    await expect(
        executeSignedCalls(deps, { ...prodParams, paymentToken: zeroAddress }),
    ).rejects.toThrow(/payer and paymentToken/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('a non-USDC fee token is refused off local', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '1', 8453))
    await expect(
        executeSignedCalls(deps, {
            ...prodParams,
            paymentMaxAmount: 100_000_000n,
            payer: EOA,
            paymentToken: WBTC }),
    ).rejects.toThrow(/native USDC/)
    await expect(
        executeSignedCalls(deps, {
            ...prodParams,
            chainId: 137,
            paymentMaxAmount: 1001n,
            payer: EOA,
            paymentToken: USDC_E }),
    ).rejects.toThrow(/native USDC/)
    await expect(
        executeSignedCalls(deps, {
            ...prodParams,
            chainId: 137,
            paymentMaxAmount: 1001n,
            payer: EOA,
            paymentToken: BASE_USDC }),
    ).rejects.toThrow(/native USDC/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('polygon native USDC is the only fee token accepted on polygon', async () => {
    const { deps, signTypedData, prepareCalls } = signingHarness((input) =>
        preparedQuote(input, '1', 137),
    )

    await executeSignedCalls(deps, {
        ...prodParams,
        chainId: 137,
        paymentMaxAmount: 100_000_000n,
        payer: EOA,
        paymentToken: POLYGON_USDC })
    expect(prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
    expect(signedCap(signTypedData)).toBe(1001n)
})

test('discloseFeeCap does not format native wei as USDC', () => {
    expect(discloseFeeCap(zeroAddress, 1001n)).toEqual({
        token: zeroAddress,
        symbol: 'none',
        amountUsdc: '1001 wei',
        expiresIn: '1h' })
    expect(discloseFeeCap(zeroAddress, 0n)).toEqual({
        token: zeroAddress,
        symbol: 'none',
        amountUsdc: '0',
        expiresIn: '1h' })
})

test('an explicit 5 USDC ceiling still signs the quote plus margin', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '1', 8453))
    await executeSignedCalls(deps, {
        ...prodParams,
        paymentMaxAmount: PAID_FEE_CAP,
        payer: EOA,
        paymentToken: BASE_USDC })
    expect(signedCap(signTypedData)).toBe(1001n)
})

test('omitting the cap while passing payer and token still signs the quote plus margin', async () => {
    const { deps, signTypedData, prepareCalls } = signingHarness((input) =>
        preparedQuote(input, '1', 8453),
    )

    const result = await executeSignedCalls(deps, {
        ...prodParams,
        payer: EOA,
        paymentToken: BASE_USDC })

    expect(prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
    expect(signedCap(signTypedData)).toBe(1001n)
    expect(result.feeCap).toEqual({
        token: BASE_USDC,
        symbol: 'USDC',
        amountUsdc: '0.001001',
        expiresIn: '1h' })
})

test('a local zero quote signs cap 0 with a zero payer and says so', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '0', 31337))

    const result = await executeSignedCalls(deps, {
        ...prodParams,
        chainId: 31337,
        env: 'dev' })

    expect(signedCap(signTypedData)).toBe(0n)

    const signed: { message: { payer: Address; paymentToken: Address } } =
        signTypedData.mock.calls[0]?.[0]?.typedData

    expect(signed.message.payer).toBe(zeroAddress)
    expect(signed.message.paymentToken).toBe(zeroAddress)
    expect(result.feeCap).toEqual({
        token: zeroAddress,
        symbol: 'none',
        amountUsdc: '0',
        expiresIn: '1h' })
})

test('dev on a non-local chain clamps an explicit cap to 5 USDC', async () => {
    const { deps, signTypedData, prepareCalls } = signingHarness((input) =>
        preparedQuote(input, '10000000', 8453),
    )

    await expect(
        executeSignedCalls(deps, {
            ...prodParams,
            chainId: 8453,
            env: 'dev',
            paymentMaxAmount: 100_000_000n,
            payer: EOA,
            paymentToken: BASE_USDC }),
    ).rejects.toThrow(/payment amount exceeds fee cap/)
    expect(prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('dev on Base omits the cap and does not sign', async () => {
    const omitted = signingHarness((input) => preparedQuote(input, '10000000', 8453))
    await expect(
        executeSignedCalls(omitted.deps, {
            ...prodParams,
            chainId: 8453,
            env: 'dev' }),
    ).rejects.toThrow(/zero address/)
    expect(omitted.prepareCalls).not.toHaveBeenCalled()
    expect(omitted.signTypedData).not.toHaveBeenCalled()

    const withUsdc = signingHarness((input) => preparedQuote(input, '10000000', 8453))
    await expect(
        executeSignedCalls(withUsdc.deps, {
            ...prodParams,
            chainId: 8453,
            env: 'dev',
            payer: EOA,
            paymentToken: BASE_USDC }),
    ).rejects.toThrow(/payment amount exceeds fee cap/)
    expect(withUsdc.prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(0n)
    expect(withUsdc.signTypedData).not.toHaveBeenCalled()
})

test('dev on Base signs an in-policy quote under an explicit cap at no more than 5 USDC', async () => {
    const { deps, signTypedData, prepareCalls } = signingHarness((input) =>
        preparedQuote(input, '1', 8453),
    )

    await executeSignedCalls(deps, {
        ...prodParams,
        chainId: 8453,
        env: 'dev',
        paymentMaxAmount: 100_000_000n,
        payer: EOA,
        paymentToken: BASE_USDC })
    expect(prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
    expect(signedCap(signTypedData)).toBe(1001n)
    expect(signedCap(signTypedData) <= PAID_FEE_CAP).toBe(true)
})

test('dev on Base clamps a max uint256 cap to 5 USDC', async () => {
    const max = 2n ** 256n - 1n
    const hugeQuote = ((max * 10_000n) / 10_500n).toString()
    const refused = signingHarness((input) => preparedQuote(input, hugeQuote, 8453))
    await expect(
        executeSignedCalls(refused.deps, {
            ...prodParams,
            chainId: 8453,
            env: 'dev',
            paymentMaxAmount: max,
            payer: EOA,
            paymentToken: BASE_USDC }),
    ).rejects.toThrow(/payment amount exceeds fee cap/)
    expect(refused.prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
    expect(refused.signTypedData).not.toHaveBeenCalled()

    const signed = signingHarness((input) => preparedQuote(input, '4761904', 8453))
    await executeSignedCalls(signed.deps, {
        ...prodParams,
        chainId: 8453,
        env: 'dev',
        paymentMaxAmount: max,
        payer: EOA,
        paymentToken: BASE_USDC })
    expect(signed.prepareCalls.mock.calls[0]?.[0]?.paymentMaxAmount).toBe(PAID_FEE_CAP)
    expect(signedCap(signed.signTypedData)).toBe(PAID_FEE_CAP)
})

test('dev on a non-local chain refuses a zero payer and token', async () => {
    const { deps, signTypedData } = signingHarness((input) => preparedQuote(input, '0', 8453))
    await expect(
        executeSignedCalls(deps, {
            ...prodParams,
            chainId: 8453,
            env: 'dev',
            paymentMaxAmount: 100_000_000n,
            payer: zeroAddress,
            paymentToken: zeroAddress }),
    ).rejects.toThrow(/zero address/)
    expect(signTypedData).not.toHaveBeenCalled()
})

test('prod send returns the fee cap for human and json output', async () => {
    const signTypedData = mock(async () => SIG)

    const sendDeps: Partial<AccountSendDeps> = {
        readKeystoreBundle: mock(async () => testKeystoreBundle(EOA)),
        decryptSessionKeystore: mock(async () => ({
            sessionPrivateKey:
                '0x8b3a350cf5c34c9194ca3a9d8b3f0d1244ec2ef5f4dbf9f8b8ce3f7b0f13f6d7' })),
        resolveAddressOrEnsInput: mock(async () => ({
            address: '0x2222222222222222222222222222222222222222',
            ens: null })),
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
        waitForBundle: mock(async () => confirmedBundle()),
    }

    const result = await executeAccountSend(
        {
            env: 'prod',
            amount: '1',
            recipient: '0x2222222222222222222222222222222222222222',
            chain: 'polygon',
            password: 'pw',
            keystorePath: '/tmp/alice.json' },
        sendDeps,
    )

    expect(result.feeCap).toEqual({
        token: POLYGON_USDC,
        symbol: 'USDC',
        amountUsdc: '0.2625',
        expiresIn: '1h' })
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
        req.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(handler(body))
        })
    })

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: `http://127.0.0.1:${boundPort(server)}` })
        })
    })
}

function rpcResult(body: string, gas: bigint): string {
    const parsed = parseJson<{ id?: number; method?: string }>(body)
    const method = parsed.method
    const result = method === 'eth_chainId' ? '0x2105' : `0x${gas.toString(16)}`

    return JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result })
}

test('a colluding RPC cannot raise the gas ceiling above twice the local formula', async () => {
    const calls = [{ target: TARGET, value: 0n, data: '0x' }]
    const local = localCombinedGasCeiling(calls)
    const { server, url } = await listen((body) => rpcResult(body, 100_000_000n))

    try {
        const ceiling = await estimateCombinedGasCeiling({
            rpcUrl: url,
            chainId: 8453,
            from: EOA,
            calls })

        expect(ceiling).toBe(local * 2n)
        expect(ceiling).toBeLessThan(800_500_000n)
    } finally {
        server.close()
    }
})

test('an RPC estimate within twice the local formula is kept', async () => {
    const calls = [{ target: TARGET, value: 0n, data: '0x' }]
    const local = localCombinedGasCeiling(calls)
    const estimated = 200_000n
    const fromRpc = estimated * 8n + 500_000n
    const { server, url } = await listen((body) => rpcResult(body, estimated))

    try {
        const ceiling = await estimateCombinedGasCeiling({
            rpcUrl: url,
            chainId: 8453,
            from: EOA,
            calls })

        expect(fromRpc > local && fromRpc < local * 2n).toBe(true)
        expect(ceiling).toBe(fromRpc)
    } finally {
        server.close()
    }
})
