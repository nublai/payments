/**
 * OIDC callers on the paid upgrade path must own the account.
 * Sponsored upgrade already uses authIdentityOwnsAccount. Paid prepare and
 * paid send must refuse an unbound OIDC token, or one bound to another
 * account, before a quote, a hold, or a broadcast. Privy and ERC-8128 stay
 * on their existing paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, zeroAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hashAuthorization, hashTypedData } from 'viem/utils'
import { orchestratorAbi } from '@nubl/contracts/abis'

import { runWithAuthIdentity, type AuthIdentity } from '../../src/auth/identity'
import type { RpcContext } from '../../src/rpc/types'
import type { Env } from '../../src/types/env'
import { handlePrepareCalls } from '../../src/rpc/methods/prepareCalls'
import { handleSendPreparedCalls } from '../../src/rpc/methods/sendPreparedCalls'
import { INVALID_PARAMS } from '../../src/rpc/errors'
import { INTENT_TYPES } from '../../src/rpc/schema/intentTypes'
import { signQuotes } from '../../src/lib/quote-signing'
import { recomputeQuotePaymentAmount } from '../../src/services/quote-payment'
import type { PaidUpgradeQuote, Quote, SignedQuotes } from '../../src/rpc/schema/prepareCalls'
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
import {
    consumeRateLimit,
    peekRateLimit,
    releaseRateLimit,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'

const { mockPrepareIntent } = vi.hoisted(() => ({
    mockPrepareIntent: vi.fn(),
}))

vi.mock('../../src/services/relayer', async () => {
    const actual = await vi.importActual<typeof import('../../src/services/relayer')>(
        '../../src/services/relayer',
    )
    return {
        ...actual,
        RelayerService: vi.fn().mockImplementation(() => ({
            prepareIntent: mockPrepareIntent,
        })),
        createIntentNonceProvider: vi.fn().mockReturnValue({}),
    }
})

vi.mock('../../src/services/fees', async () => {
    const actual = await vi.importActual<typeof import('../../src/services/fees')>(
        '../../src/services/fees',
    )
    return {
        ...actual,
        getFeeEstimate: vi.fn().mockResolvedValue({
            baseFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            maxFeePerGas: 1_000_000_000n,
            totalGas: 100_000n,
            paymentAmount: 1_000_000_000_000_000n,
        }),
    }
})

vi.mock('../../src/services/price-oracle', async () => {
    const actual = await vi.importActual<typeof import('../../src/services/price-oracle')>(
        '../../src/services/price-oracle',
    )
    return {
        ...actual,
        getUsdPrice: vi.fn(async (assetUid: string) =>
            assetUid === 'usdc' ? 10n ** 18n : 3000n * 10n ** 18n,
        ),
    }
})

const CHAIN_ID = 8453
const SECRET = 'paid-upgrade-oidc-owner-secret'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const ACCOUNT_PROXY = '0x3Be52867f8Dca2911f81076B37921c334dE29551' as Address
const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address
const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const OTHER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e141207b4c24b44a4361' as Hex
const ISSUER = 'https://issuer.example'
const NATIVE_RATE = (3000n * 10n ** 18n).toString()
const OWNER = privateKeyToAccount(OWNER_KEY).address
const OTHER = privateKeyToAccount(OTHER_KEY).address

const rpc = {
    balance: 20_000_000n,
    receiptGas: '0x44444' as Hex,
}

const gasLog: Array<Record<string, unknown>> = []
const rateBodies: Array<Record<string, unknown>> = []
let captures: unknown[] = []
let gasSpent = 0n
let gasHeld = 0n
const rateStore = new Map<string, number>()

function word(value: bigint): Hex {
    return `0x${value.toString(16).padStart(64, '0')}` as Hex
}

function jsonResponse(body: unknown, ok = true): Response {
    return { ok, json: async () => body } as Response
}

function applyGas(body: Record<string, unknown>): { allowed: boolean; gas?: number } {
    gasLog.push(body)
    const amount = BigInt(typeof body.gas === 'string' ? body.gas : '0')
    if (body.action === 'reserve-gas') {
        gasHeld += amount
        return { allowed: true, gas: Number(gasSpent) }
    }
    if (body.action === 'release-gas') {
        gasHeld = gasHeld > amount ? gasHeld - amount : 0n
        return { allowed: true, gas: Number(gasSpent) }
    }
    if (body.action === 'settle-gas') {
        const hold = BigInt(typeof body.hold === 'string' ? body.hold : '0')
        gasHeld = gasHeld > hold ? gasHeld - hold : 0n
        gasSpent += amount
        return { allowed: true, gas: Number(gasSpent) }
    }
    return { allowed: true }
}

function poolFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.includes('upgrade-rate-limit')) {
        if (
            body.action === 'reserve-gas' ||
            body.action === 'release-gas' ||
            body.action === 'settle-gas' ||
            body.action === 'enqueue-receipt'
        ) {
            return Promise.resolve(jsonResponse(applyGas(body)))
        }
        rateBodies.push(body)
        const now = Math.floor(Date.now() / 1000)
        const buckets = paidUpgradeRateBuckets({
            chainId: typeof body.chainId === 'number' ? body.chainId : CHAIN_ID,
            account: typeof body.account === 'string' ? body.account : 'unknown',
            ip: typeof body.ip === 'string' ? body.ip : 'unknown',
            includeGlobal: body.action === 'reserve' || body.action === 'release',
        })
        if (body.action === 'peek') {
            return Promise.resolve(jsonResponse({ allowed: peekRateLimit(rateStore, buckets, now).allowed }))
        }
        if (body.action === 'release') {
            releaseRateLimit(
                rateStore,
                buckets,
                typeof body.reservedAt === 'number' ? body.reservedAt : now,
            )
            return Promise.resolve(jsonResponse({ allowed: true }))
        }
        const decision = consumeRateLimit(rateStore, buckets, now)
        return Promise.resolve(jsonResponse({ allowed: decision.allowed, reservedAt: now }))
    }
    captures.push(body)
    return Promise.resolve(
        jsonResponse({
            txHash: `0x${'ab'.repeat(32)}`,
            signer: '0x123',
            signerName: 'signer-8453-0',
        }),
    )
}

function createCtx(): RpcContext {
    return {
        request: new Request('https://relayer.local/'),
        auth: { provider: 'erc8128', userId: OWNER },
        env: {
            RPC_URL: 'http://rpc.test/8453',
            RPC_8453: 'http://rpc.test/8453',
            CHAIN_IDS: String(CHAIN_ID),
            CONTEXT: 'local',
            PAID_UPGRADE_ENABLED: 'true',
            RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
            RELAYER_COUNT: '1',
            QUOTE_SIGNING_SECRET: SECRET,
            ORCHESTRATOR_8453: ORCHESTRATOR,
            SIMPLE_FUNDER_8453: '0x41D23D227C6D0F732D41eE5c203C48d96292A48B',
            SIMULATOR_8453: '0xDAD7c34d0c41698B227D3C5ee3d6d88A78c63a65',
            ACCOUNT_8453: '0x2eEBFfcFABEB8cE3AC016effFeC37dBBAccCff2a',
            ACCOUNT_PROXY_8453: ACCOUNT_PROXY,
            SIMPLE_SETTLER_8453: '0x5386d1026e1598177e03eA52cbF1a0994ADF5eaE',
            ESCROW_8453: '0x05f9597eed844410b7c0746A1C584188d0644730',
            MULTI_SIG_SIGNER_8453: '0xa3972FEebd6E1f973eD19cC586D79B3F61f892A3',
            INTENT_NONCE_MANAGER: {},
            SIGNER_POOL: {
                idFromName: () => 'pool-id',
                get: () => ({ fetch: poolFetch }),
            },
        } as unknown as Env,
    }
}

function oidc(boundAccounts?: Address[]): AuthIdentity {
    return {
        provider: 'oidc',
        userId: 'user_oidc_1',
        issuer: ISSUER,
        boundAccounts,
    }
}

async function signAuth(key: Hex, delegation: Address, nonce: number): Promise<Hex> {
    return privateKeyToAccount(key).sign({
        hash: hashAuthorization({ contractAddress: delegation, chainId: CHAIN_ID, nonce }),
    })
}

async function signedPreCall(ownerKey: Hex): Promise<PaidUpgradeQuote['preCall']> {
    const owner = privateKeyToAccount(ownerKey)
    const session = privateKeyToAccount(generatePrivateKey())
    const publicKey = encodeAbiParameters([{ type: 'address' }], [session.address])
    const { calls, executionData } = buildKeyInitializationData(
        [{ expiry: '0', type: 'secp256k1', role: 'admin', publicKey, permissions: [] }],
        owner.address,
    )
    const signature = await owner.signTypedData({
        domain: getSignedCallDomain(CHAIN_ID, ORCHESTRATOR),
        types: SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message: { multichain: false, eoa: owner.address, calls, nonce: UPGRADE_PRECALL_NONCE },
    })
    return {
        eoa: owner.address,
        executionData,
        nonce: UPGRADE_PRECALL_NONCE.toString(),
        signature,
    }
}

async function upgradeQuote(): Promise<PaidUpgradeQuote> {
    const preCall = await signedPreCall(OWNER_KEY)
    return {
        authorization: {
            contractAddress: ACCOUNT_PROXY,
            chainId: CHAIN_ID,
            nonce: 0,
            signature: await signAuth(OWNER_KEY, ACCOUNT_PROXY, 0),
        },
        preCall,
    }
}

function preparedIntent(eoa: Address) {
    return {
        success: true,
        typedData: {
            domain: {
                name: 'Orchestrator',
                version: '0.5.5',
                chainId: CHAIN_ID,
                verifyingContract: ORCHESTRATOR,
            },
            types: INTENT_TYPES,
            primaryType: 'Intent' as const,
            message: {
                multichain: false,
                eoa,
                calls: [{ to: USDC, value: 0n, data: '0x' as Hex }],
                nonce: 0n,
                payer: eoa,
                paymentToken: USDC,
                paymentMaxAmount: 1n,
                combinedGas: 150_000n,
                encodedPreCalls: [] as Hex[],
                encodedFundTransfers: [] as Hex[],
                settler: zeroAddress,
                expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
            },
        },
        digest: `0x${'11'.repeat(32)}` as Hex,
        nonce: '0',
        combinedGas: '150000',
        txGas: '100000',
        simulationGas: '50000',
        expiry: String(Math.floor(Date.now() / 1000) + 3600),
    }
}

async function prepareParams(): Promise<unknown> {
    return {
        from: OWNER,
        chain_id: '0x2105',
        calls: [{ to: USDC, value: '0x0', data: '0x' }],
        capabilities: {
            meta: { fee_payer: OWNER, fee_token: USDC },
            accountUpgrade: await upgradeQuote(),
        },
    }
}

async function sendParams(): Promise<unknown> {
    const upgrade = await upgradeQuote()
    const encoded = [encodeSignedPreCall(upgrade.preCall)]
    const txGas = 100_000
    const maxFeePerGas = 1_000_000_000
    const paymentAmount = recomputeQuotePaymentAmount({
        txGas,
        maxFeePerGas,
        paymentToken: USDC,
        paymentTokenDecimals: 6,
        nativeRate: NATIVE_RATE,
    })
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
            paymentMaxAmount: (paymentAmount + (paymentAmount * 500n) / 10_000n).toString(),
        },
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
        accountUpgrade: upgrade,
    }
    const signed: SignedQuotes = {
        quotes: [quote],
        signature: '0x',
        ttl: Math.floor(Date.now() / 1000) + 300,
    }
    signed.signature = await signQuotes(signed, SECRET)
    const intent = quote.intent
    const digest = hashTypedData({
        domain: {
            name: 'Orchestrator',
            version: '0.5.5',
            chainId: CHAIN_ID,
            verifyingContract: ORCHESTRATOR,
        },
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message: {
            multichain: false,
            eoa: intent.eoa as Address,
            calls: intent.calls.map((call) => ({
                to: call.to as Address,
                value: BigInt(call.value || '0'),
                data: call.data as Hex,
            })),
            nonce: BigInt(intent.nonce),
            payer: OWNER,
            paymentToken: USDC,
            paymentMaxAmount: BigInt(intent.paymentMaxAmount ?? '0'),
            combinedGas: BigInt(intent.combinedGas),
            encodedPreCalls: encoded,
            encodedFundTransfers: [] as Hex[],
            settler: zeroAddress,
            expiry: BigInt(intent.expiry),
        },
    })
    return {
        context: { quote: signed },
        signature: await privateKeyToAccount(OWNER_KEY).sign({ hash: digest }),
    }
}

function intentExecutedLog() {
    return {
        address: ORCHESTRATOR,
        topics: encodeEventTopics({
            abi: orchestratorAbi,
            eventName: 'IntentExecuted',
            args: { eoa: OWNER, nonce: 0n },
        }),
        data: encodeAbiParameters(
            [{ type: 'bool' }, { type: 'bytes4' }],
            [true, '0x00000000'],
        ),
        logIndex: '0x0',
        transactionIndex: '0x0',
        transactionHash: `0x${'ab'.repeat(32)}`,
        blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x1',
        removed: false,
    }
}

beforeEach(() => {
    captures = []
    rateBodies.length = 0
    gasLog.length = 0
    gasSpent = 0n
    gasHeld = 0n
    rateStore.clear()
    mockPrepareIntent.mockReset()
    mockPrepareIntent.mockImplementation(async () => preparedIntent(OWNER))
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
        if (!url.includes('rpc.test')) throw new Error(`unexpected fetch ${url}`)
        const raw = init?.body ? JSON.parse(String(init.body)) : {}
        const batch = Array.isArray(raw) ? raw : [raw]
        const results = batch.map((call: { id?: number; method?: string; params?: unknown[] }) => {
            let result: unknown = '0x'
            const tx = call.params?.[0] as { authorizationList?: unknown } | undefined
            if (call.method === 'eth_getCode') result = '0x'
            else if (call.method === 'eth_getTransactionCount') result = '0x0'
            else if (call.method === 'eth_call' && tx?.authorizationList) result = word(0n)
            else if (call.method === 'eth_call') result = word(rpc.balance)
            else if (call.method === 'eth_chainId') result = '0x2105'
            else if (call.method === 'eth_getTransactionReceipt') {
                result = {
                    transactionHash: `0x${'ab'.repeat(32)}`,
                    transactionIndex: '0x0',
                    blockHash: `0x${'cd'.repeat(32)}`,
                    blockNumber: '0x1',
                    from: `0x${'11'.repeat(20)}`,
                    to: ORCHESTRATOR,
                    cumulativeGasUsed: rpc.receiptGas,
                    gasUsed: rpc.receiptGas,
                    contractAddress: null,
                    logs: [intentExecutedLog()],
                    logsBloom: `0x${'00'.repeat(256)}`,
                    status: '0x1',
                    effectiveGasPrice: '0x3b9aca00',
                    type: '0x4',
                }
            }
            return { jsonrpc: '2.0', id: call.id ?? 1, result }
        })
        return new Response(JSON.stringify(Array.isArray(raw) ? results : results[0]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const unbound = {
    code: INVALID_PARAMS,
    message: 'Authenticated identity is not bound to the account',
}

describe('paid upgrade OIDC ownership', () => {
    it('refuses an OIDC token with no binding on paid prepare', async () => {
        const params = await prepareParams()
        await expect(
            runWithAuthIdentity(oidc(), () => handlePrepareCalls(params, createCtx())),
        ).rejects.toMatchObject(unbound)
        expect(mockPrepareIntent).not.toHaveBeenCalled()
        expect(rateBodies).toHaveLength(0)
        expect(captures).toHaveLength(0)
        expect(gasLog).toHaveLength(0)
    })

    it('refuses an OIDC token with no binding on paid send', async () => {
        const params = await sendParams()
        await expect(
            runWithAuthIdentity(oidc(), () => handleSendPreparedCalls(params, createCtx())),
        ).rejects.toMatchObject(unbound)
        expect(captures).toHaveLength(0)
        expect(gasLog).toHaveLength(0)
        expect(rateBodies).toHaveLength(0)
    })

    it('refuses an OIDC token bound to another account on paid prepare and paid send', async () => {
        const prepare = await prepareParams()
        await expect(
            runWithAuthIdentity(oidc([OTHER]), () => handlePrepareCalls(prepare, createCtx())),
        ).rejects.toMatchObject(unbound)
        expect(mockPrepareIntent).not.toHaveBeenCalled()

        const send = await sendParams()
        await expect(
            runWithAuthIdentity(oidc([OTHER]), () => handleSendPreparedCalls(send, createCtx())),
        ).rejects.toMatchObject(unbound)
        expect(captures).toHaveLength(0)
        expect(gasLog).toHaveLength(0)
        expect(rateBodies).toHaveLength(0)
    })

    it('prepares and sends a paid upgrade for an OIDC token bound to that account', async () => {
        const identity = oidc([OWNER])
        const prepare = await prepareParams()
        const prepared = await runWithAuthIdentity(identity, () =>
            handlePrepareCalls(prepare, createCtx()),
        )
        expect(prepared.context.quote.quotes[0]?.accountUpgrade?.authorization.contractAddress).toBe(
            ACCOUNT_PROXY,
        )
        expect(mockPrepareIntent).toHaveBeenCalledOnce()

        const send = await sendParams()
        const sent = await runWithAuthIdentity(identity, () =>
            handleSendPreparedCalls(send, createCtx()),
        )
        expect(sent.id).toEqual(expect.any(String))
        expect(captures).toHaveLength(1)
    })

    it('prepares and sends a paid upgrade for Privy without a binding', async () => {
        const identity: AuthIdentity = { provider: 'privy', userId: 'did:privy:abc' }
        const prepare = await prepareParams()
        const prepared = await runWithAuthIdentity(identity, () =>
            handlePrepareCalls(prepare, createCtx()),
        )
        expect(prepared.digest).toMatch(/^0x[0-9a-fA-F]{64}$/)

        const send = await sendParams()
        const sent = await runWithAuthIdentity(identity, () =>
            handleSendPreparedCalls(send, createCtx()),
        )
        expect(sent.id).toEqual(expect.any(String))
        expect(captures).toHaveLength(1)
    })

    it('prepares and sends a paid upgrade for a wallet-signed caller', async () => {
        const identity: AuthIdentity = { provider: 'erc8128', userId: OWNER }
        const ctx = createCtx()
        ctx.auth = { provider: 'erc8128', userId: OWNER }
        const prepare = await prepareParams()
        const prepared = await runWithAuthIdentity(identity, () => handlePrepareCalls(prepare, ctx))
        expect(prepared.context.quote.quotes[0]?.intent.eoa).toBe(OWNER)

        const send = await sendParams()
        const sent = await runWithAuthIdentity(identity, () => handleSendPreparedCalls(send, ctx))
        expect(sent.id).toEqual(expect.any(String))
        expect(captures).toHaveLength(1)
    })
})
