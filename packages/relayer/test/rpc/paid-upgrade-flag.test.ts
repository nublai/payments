/**
 * Launch sponsors every first upgrade. The paid first-upgrade path stays in
 * the code but is off unless PAID_UPGRADE_ENABLED is exactly "true". Off
 * refuses paid prepare and paid send before any rate-limit bucket, gas hold,
 * simulation, signer call, or broadcast. A quote signed while the flag was on
 * is refused once it is off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, zeroAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hashAuthorization, hashTypedData } from 'viem/utils'
import { orchestratorAbi } from '@nubl/contracts/abis'

import type {RpcContext} from '../../src/rpc/types'
import type {Env} from '../../src/types/env'
import { handlePrepareCalls } from '../../src/rpc/methods/prepareCalls'
import { handleSendPreparedCalls } from '../../src/rpc/methods/sendPreparedCalls'
import { INVALID_PARAMS } from '../../src/rpc/errors'
import { INTENT_TYPES } from '../../src/rpc/schema/intentTypes'
import { signQuotes } from '../../src/lib/quote-signing'
import { recomputeQuotePaymentAmount } from '../../src/services/quote-payment'
import type {PaidUpgradeQuote, Quote, SignedQuotes} from '../../src/rpc/schema/prepareCalls'
import {
    buildKeyInitializationData,
    getSignedCallDomain,
    SIGNED_CALL_TYPES,
    UPGRADE_PRECALL_NONCE,
} from '../../src/rpc/methods/shared/account-helpers'
import {
    encodeSignedPreCall,
    paidUpgradeRateBuckets,
} from '../../src/rpc/methods/shared/paid-upgrade'
import { consumeRateLimit, peekRateLimit } from '../../src/rpc/methods/shared/upgrade-rate-limit'
import { emptyHex, repeatedHex, wordHex } from '../helpers/hex'
import { testEnv } from '../helpers/env'
import { parseJson } from '../helpers/rpc'
import { jsonStub, signerPoolWithFetch } from '../helpers/stubs'
import { stubPrepareRelayer, stubUsdPrice } from '../helpers/fakes'
import type { FeeEstimate } from '../../src/services/fees'
import type { PrepareIntentResult, RelayerService } from '../../src/services/relayer'

const mockPrepareIntent = vi.fn<RelayerService['prepareIntent']>()

const paidUpgradeFee = {
    baseFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    maxFeePerGas: 1_000_000_000n,
    totalGas: 100_000n,
    paymentAmount: 1_000_000_000_000_000n,
} satisfies FeeEstimate

const CHAIN_ID = 8453

const SECRET = 'paid-upgrade-flag-secret'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const ACCOUNT_PROXY = '0x3Be52867f8Dca2911f81076B37921c334dE29551'

const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8'

const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const OWNER = privateKeyToAccount(OWNER_KEY).address

const NATIVE_RATE = (3000n * 10n ** 18n).toString()

const disabled = {
    code: INVALID_PARAMS,
    message: expect.stringMatching(
        /Paid account upgrades are disabled.*wallet_prepareUpgradeAccount.*wallet_upgradeAccount.*sponsored/,
    ) }

const rateBodies: Array<Record<string, unknown>> = []

const gasLog: Array<Record<string, unknown>> = []

const rpcMethods: string[] = []

let captures: unknown[] = []

const rateStore = new Map<string, number>()

function word(value: bigint): Hex {
    return wordHex(value)
}

type PoolRequestBody = {
    action?: string
    account?: string
    ip?: string
}

function poolFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const body = init?.body ? parseJson<PoolRequestBody>(String(init.body)) : {}

    if (url.includes('upgrade-rate-limit')) {
        if (typeof body.action === 'string' && body.action.endsWith('-gas')) {
            gasLog.push(body)

            return Promise.resolve(jsonStub({ allowed: true, gas: 0 }))
        }

        if (body.action === 'enqueue-receipt') {
            gasLog.push(body)

            return Promise.resolve(jsonStub({ allowed: true }))
        }

        rateBodies.push(body)
        const now = Math.floor(Date.now() / 1000)

        const buckets = paidUpgradeRateBuckets({
            chainId: CHAIN_ID,
            account: String(body.account ?? 'unknown'),
            ip: String(body.ip ?? 'unknown'),
            includeGlobal: body.action === 'reserve' || body.action === 'release' })

        if (body.action === 'peek') {
            return Promise.resolve(jsonStub({ allowed: peekRateLimit(rateStore, buckets, now).allowed }))
        }

        if (body.action === 'release') return Promise.resolve(jsonStub({ allowed: true }))
        const decision = consumeRateLimit(rateStore, buckets, now)

        return Promise.resolve(jsonStub({ allowed: decision.allowed, reservedAt: now }))
    }

    captures.push(body)

    return Promise.resolve(
        jsonStub({
            txHash: `0x${'ab'.repeat(32)}`,
            signer: '0x123',
            signerName: 'signer-8453-0' }),
    )
}

function createCtx(flag?: string): RpcContext {
    const overrides: Partial<Env> = {
        RPC_URL: 'http://rpc.test/8453',
        RPC_8453: 'http://rpc.test/8453',
        CHAIN_IDS: String(CHAIN_ID),
        CONTEXT: 'local',
        RELAYER_COUNT: '1',
        QUOTE_SIGNING_SECRET: SECRET,
        SIGNER_POOL: signerPoolWithFetch(poolFetch),
    }

    if (flag !== undefined) {
        overrides.PAID_UPGRADE_ENABLED = flag
    }

    return {
        request: new Request('https://relayer.local/'),
        env: Object.assign(
            testEnv(overrides),
            {
                ORCHESTRATOR_8453: ORCHESTRATOR,
                SIMPLE_FUNDER_8453: '0x41D23D227C6D0F732D41eE5c203C48d96292A48B',
                SIMULATOR_8453: '0xDAD7c34d0c41698B227D3C5ee3d6d88A78c63a65',
                ACCOUNT_8453: '0x2eEBFfcFABEB8cE3AC016effFeC37dBBAccCff2a',
                ACCOUNT_PROXY_8453: ACCOUNT_PROXY,
                SIMPLE_SETTLER_8453: '0x5386d1026e1598177e03eA52cbF1a0994ADF5eaE',
                ESCROW_8453: '0x05f9597eed844410b7c0746A1C584188d0644730',
                MULTI_SIG_SIGNER_8453: '0xa3972FEebd6E1f973eD19cC586D79B3F61f892A3',
            },
        ),
        deps: {
            createRelayerService: stubPrepareRelayer(mockPrepareIntent),
            getFeeEstimate: async () => paidUpgradeFee,
            getUsdPrice: stubUsdPrice((assetUid) =>
                assetUid === 'usdc' ? 10n ** 18n : 3000n * 10n ** 18n,
            ),
        },
    }
}

async function upgradeQuote(): Promise<PaidUpgradeQuote> {
    const owner = privateKeyToAccount(OWNER_KEY)
    const session = privateKeyToAccount(generatePrivateKey())
    const publicKey = encodeAbiParameters([{ type: 'address' }], [session.address])

    const { calls, executionData } = buildKeyInitializationData(
        [{ expiry: '0', type: 'secp256k1', role: 'admin', publicKey, permissions: [] }],
        owner.address,
    )

    const preCallSignature = await owner.signTypedData({
        domain: getSignedCallDomain(CHAIN_ID, ORCHESTRATOR),
        types: SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message: { multichain: false, eoa: owner.address, calls, nonce: UPGRADE_PRECALL_NONCE } })

    return {
        authorization: {
            contractAddress: ACCOUNT_PROXY,
            chainId: CHAIN_ID,
            nonce: 0,
            signature: await owner.sign({
                hash: hashAuthorization({ contractAddress: ACCOUNT_PROXY, chainId: CHAIN_ID, nonce: 0 }) }) },
        preCall: {
            eoa: owner.address,
            executionData,
            nonce: UPGRADE_PRECALL_NONCE.toString(),
            signature: preCallSignature } }
}

function preparedIntent(): PrepareIntentResult {
    return {
        success: true,
        typedData: {
            domain: {
                name: 'Orchestrator',
                version: '0.5.5',
                chainId: CHAIN_ID,
                verifyingContract: ORCHESTRATOR },
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message: {
                multichain: false,
                eoa: OWNER,
                calls: [{ to: USDC, value: 0n, data: '0x' }],
                nonce: 0n,
                payer: OWNER,
                paymentToken: USDC,
                paymentMaxAmount: 1n,
                combinedGas: 150_000n,
                encodedPreCalls: emptyHex(),
                encodedFundTransfers: emptyHex(),
                settler: zeroAddress,
                expiry: BigInt(Math.floor(Date.now() / 1000) + 3600) } },
        digest: repeatedHex('11', 32),
        nonce: '0',
        combinedGas: '150000',
        txGas: '100000',
        simulationGas: '50000',
        expiry: String(Math.floor(Date.now() / 1000) + 3600) }
}

function plainPrepareParams(): unknown {
    return {
        from: OWNER,
        chain_id: '0x2105',
        calls: [{ to: USDC, value: '0x0', data: '0x' }],
        capabilities: { meta: { fee_payer: OWNER, fee_token: USDC } } }
}

async function paidPrepareParams(): Promise<unknown> {
    return {
        from: OWNER,
        chain_id: '0x2105',
        calls: [{ to: USDC, value: '0x0', data: '0x' }],
        capabilities: {
            meta: { fee_payer: OWNER, fee_token: USDC },
            accountUpgrade: await upgradeQuote() } }
}

/** A paid quote HMAC-signed with the relayer secret, the way prepare signs it with the flag on. */
async function signedPaidSendParams(): Promise<unknown> {
    const upgrade = await upgradeQuote()
    const encoded = [encodeSignedPreCall(upgrade.preCall)]
    const txGas = 100_000
    const maxFeePerGas = 1_000_000_000

    const paymentAmount = recomputeQuotePaymentAmount({
        txGas,
        maxFeePerGas,
        paymentToken: USDC,
        paymentTokenDecimals: 6,
        nativeRate: NATIVE_RATE })

    const quote: Quote = {
        chainId: '0x2105',
        intent: {
            eoa: OWNER,
            calls: [{ to: USDC, value: '0', data: '0x' }],
            nonce: '0',
            combinedGas: '500000',
            expiry: String(Math.floor(Date.now() / 1000) + 3600),
            encodedPreCalls: encoded,
            payer: OWNER,
            paymentToken: USDC,
            paymentMaxAmount: (paymentAmount + (paymentAmount * 500n) / 10_000n).toString() },
        orchestrator: ORCHESTRATOR,
        extraPayment: '0x0',
        ethPrice: '0x0',
        paymentTokenDecimals: 6,
        txGas,
        nativeFeeEstimate: { maxFeePerGas, maxPriorityFeePerGas: 1_000_000 },
        paymentAmount: paymentAmount.toString(),
        nativeRate: NATIVE_RATE,
        authSigner: OWNER,
        feeTokenDeficit: '0x0',
        assetDeficits: [],
        accountUpgrade: upgrade }

    const signed: SignedQuotes = {
        quotes: [quote],
        signature: '0x',
        ttl: Math.floor(Date.now() / 1000) + 300 }

    signed.signature = await signQuotes(signed, SECRET)
    const intent = quote.intent

    const digest = hashTypedData({
        domain: { name: 'Orchestrator', version: '0.5.5', chainId: CHAIN_ID, verifyingContract: ORCHESTRATOR },
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message: {
            multichain: false,
            eoa: OWNER,
            calls: [{ to: USDC, value: 0n, data: '0x' }],
            nonce: 0n,
            payer: OWNER,
            paymentToken: USDC,
            paymentMaxAmount: BigInt(intent.paymentMaxAmount ?? '0'),
            combinedGas: BigInt(intent.combinedGas),
            encodedPreCalls: encoded,
            encodedFundTransfers: emptyHex(),
            settler: zeroAddress,
            expiry: BigInt(intent.expiry) } })

    return {
        context: { quote: signed },
        signature: await privateKeyToAccount(OWNER_KEY).sign({ hash: digest }) }
}

function intentExecutedLog() {
    return {
        address: ORCHESTRATOR,
        topics: encodeEventTopics({
            abi: orchestratorAbi,
            eventName: 'IntentExecuted',
            args: { eoa: OWNER, nonce: 0n } }),
        data: encodeAbiParameters([{ type: 'bool' }, { type: 'bytes4' }], [true, '0x00000000']),
        logIndex: '0x0',
        transactionIndex: '0x0',
        transactionHash: `0x${'ab'.repeat(32)}`,
        blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x1',
        removed: false }
}

function resetSideEffects(): void {
    captures = []
    rateBodies.length = 0
    gasLog.length = 0
    rpcMethods.length = 0
    rateStore.clear()
    mockPrepareIntent.mockClear()
}

function expectNoPaidSideEffects(): void {
    expect(mockPrepareIntent).not.toHaveBeenCalled()
    expect(rateBodies).toEqual([])
    expect(gasLog).toEqual([])
    expect(captures).toEqual([])
    expect(rpcMethods).toEqual([])
}

beforeEach(() => {
    resetSideEffects()
    mockPrepareIntent.mockReset()
    mockPrepareIntent.mockImplementation(async () => preparedIntent())
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)

        if (!url.includes('rpc.test')) throw new Error(`unexpected fetch ${url}`)
        const raw = init?.body ? JSON.parse(String(init.body)) : {}
        const batch = Array.isArray(raw) ? raw : [raw]

        const results = batch.map((call: { id?: number; method?: string; params?: unknown[] }) => {
            rpcMethods.push(call.method ?? '')
            let result: unknown = '0x'

            type RpcTx = { authorizationList?: readonly object[] }

            // SAFETY: this stub records the eth_call tx object the handler puts in params[0].
            const tx = call.params?.[0] as RpcTx | undefined

            if (call.method === 'eth_getCode') result = '0x'
            else if (call.method === 'eth_getTransactionCount') result = '0x0'
            else if (call.method === 'eth_call' && tx?.authorizationList) result = word(0n)
            else if (call.method === 'eth_call') result = word(20_000_000n)
            else if (call.method === 'eth_chainId') result = '0x2105'
            else if (call.method === 'eth_getTransactionReceipt') {
                result = {
                    transactionHash: `0x${'ab'.repeat(32)}`,
                    transactionIndex: '0x0',
                    blockHash: `0x${'cd'.repeat(32)}`,
                    blockNumber: '0x1',
                    from: `0x${'11'.repeat(20)}`,
                    to: ORCHESTRATOR,
                    cumulativeGasUsed: '0x44444',
                    gasUsed: '0x44444',
                    contractAddress: null,
                    logs: [intentExecutedLog()],
                    logsBloom: `0x${'00'.repeat(256)}`,
                    status: '0x1',
                    effectiveGasPrice: '0x3b9aca00',
                    type: '0x4' }
            }

            return { jsonrpc: '2.0', id: call.id ?? 1, result }
        })

        return new Response(JSON.stringify(Array.isArray(raw) ? results : results[0]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' } })
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('PAID_UPGRADE_ENABLED', () => {
    it('refuses a paid wallet_prepareCalls with the flag off, with no rate limit, hold, or simulation', async () => {
        await expect(handlePrepareCalls(await paidPrepareParams(), createCtx())).rejects.toMatchObject(
            disabled,
        )
        expectNoPaidSideEffects()
    })

    it('refuses a paid quote signed while the flag was on once the flag is off', async () => {
        const sendable = await signedPaidSendParams()
        await expect(handleSendPreparedCalls(sendable, createCtx('false'))).rejects.toMatchObject(
            disabled,
        )
        expectNoPaidSideEffects()

        const prepared = await handlePrepareCalls(await paidPrepareParams(), createCtx('true'))
        expect(prepared.context.quote.quotes[0]?.accountUpgrade).toBeDefined()
        expect(prepared.context.quote.signature).not.toBe('0x')
        resetSideEffects()

        const relayerSigned = {
            context: prepared.context,
            signature: await privateKeyToAccount(OWNER_KEY).sign({ hash: prepared.digest }) }

        await expect(handleSendPreparedCalls(relayerSigned, createCtx())).rejects.toMatchObject(
            disabled,
        )
        expectNoPaidSideEffects()

        const sent = await handleSendPreparedCalls(sendable, createCtx('true'))
        expect(sent.id).toEqual(expect.any(String))
        expect(captures).toHaveLength(1)
    })

    it('treats unset, empty, "false", and anything but the exact string "true" as off', async () => {
        for (const flag of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
            resetSideEffects()
            await expect(
                handlePrepareCalls(await paidPrepareParams(), createCtx(flag)),
                `PAID_UPGRADE_ENABLED=${JSON.stringify(flag)}`,
            ).rejects.toMatchObject(disabled)
            expectNoPaidSideEffects()
            await expect(
                handleSendPreparedCalls(await signedPaidSendParams(), createCtx(flag)),
                `PAID_UPGRADE_ENABLED=${JSON.stringify(flag)}`,
            ).rejects.toMatchObject(disabled)
            expectNoPaidSideEffects()
        }

        resetSideEffects()
        const prepared = await handlePrepareCalls(await paidPrepareParams(), createCtx('true'))
        expect(prepared.context.quote.quotes[0]?.accountUpgrade).toBeDefined()
        expect(rateBodies.map((body) => body.action)).toEqual(['peek', 'commit'])
    })

    it('still prepares a normal non-upgrade wallet_prepareCalls with the flag off', async () => {
        const ctx = createCtx()
        await expect(handlePrepareCalls(await paidPrepareParams(), ctx)).rejects.toMatchObject(disabled)
        expectNoPaidSideEffects()

        const prepared = await handlePrepareCalls(plainPrepareParams(), ctx)
        expect(prepared.digest).toMatch(/^0x[0-9a-fA-F]{64}$/)
        expect(prepared.context.quote.quotes[0]?.accountUpgrade).toBeUndefined()
        expect(mockPrepareIntent).toHaveBeenCalledOnce()
        expect(rateBodies).toEqual([])
        expect(gasLog).toEqual([])
    })
})
