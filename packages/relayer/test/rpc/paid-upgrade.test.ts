/**
 * User-paid first EIP-7702 upgrade through wallet_sendPreparedCalls.
 * These cases refuse on the paid path. A quote with no accountUpgrade still
 * takes the existing execute-intent path.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, zeroAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hashAuthorization, hashTypedData } from 'viem/utils'
import { orchestratorAbi } from '@nubl/contracts/abis'

import { installDeployment } from '../deployment-fixture'
import type { RpcContext } from '../../src/rpc/types'
import type { Env } from '../../src/types/env'
import {
    handleBatchSendPreparedCalls,
    handleSendPreparedCalls,
} from '../../src/rpc/methods/sendPreparedCalls'
import {
    INVALID_PARAMS,
    INVALID_QUOTE_SIGNATURE,
    INVALID_SIGNATURE,
    INSUFFICIENT_FUNDS,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
} from '../../src/rpc/errors'
import { INTENT_TYPES } from '../../src/rpc/schema/intentTypes'
import { recomputeQuotePaymentAmount } from '../../src/services/quote-payment'
import { signQuotes } from '../../src/lib/quote-signing'
import type { PaidUpgradeQuote, Quote, SignedQuotes } from '../../src/rpc/schema/prepareCalls'
import type { SendPreparedCallsParams } from '../../src/rpc/schema/sendPreparedCalls'
import {
    buildKeyInitializationData,
    getSignedCallDomain,
    SIGNED_CALL_TYPES,
    UPGRADE_PRECALL_NONCE,
} from '../../src/rpc/methods/shared/account-helpers'
import {
    encodeSignedPreCall,
    PAID_UPGRADE_ADDRESS_LIMIT,
    paidUpgradeRateBuckets,
    recordPaidUpgradeRateLimit,
} from '../../src/rpc/methods/shared/paid-upgrade'
import {
    consumeRateLimit,
    peekRateLimit,
    releaseRateLimit,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'
import { emptyHex, hex, repeatedHex, wordHex } from '../helpers/hex'
import { testEnv } from '../helpers/env'
import { parseJson } from '../helpers/rpc'
import { jsonStub, signerPoolWithFetch } from '../helpers/stubs'

const CHAIN_ID = 8453

const SECRET = 'paid-upgrade-test-secret'

const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const ACCOUNT_PROXY: Address = '0x3Be52867f8Dca2911f81076B37921c334dE29551'

const ORCHESTRATOR: Address = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8'

const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const OTHER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e141207b4c24b44a4361'

const NATIVE_RATE = (3000n * 10n ** 18n).toString()

const rpc = {
    code: hex('0x'),
    nonce: hex('0x0'),
    balance: 20_000_000n,
    executeResult: repeatedHex('00', 32),
    receiptErr: hex('0x00000000'),
    receiptGas: hex('0x44444'),
    rateThrow: false,
    gasThrow: false,
    failBroadcast: false,
    broadcastAttempted: false,
    gasBudget: 2_000_000n,
    receiptMissing: false,
}

const gasLog: PoolRequestBody[] = []

let gasSpent = 0n

let gasHeld = 0n

let gasFailures = 0

function word(value: bigint): Hex {
    return wordHex(value)
}

let captures: unknown[] = []

const rpcCalls: Array<{ method?: string; params?: unknown[] }> = []

type PoolRequestBody = {
    action?: string
    gas?: string
    hold?: string
    failure?: boolean
    chainId?: number
    account?: string
    ip?: string
    reservedAt?: number
    type?: string
    txHash?: string
}

const rateBodies: PoolRequestBody[] = []

const rateStore = new Map<string, number>()

function applyGas(body: PoolRequestBody): { allowed: boolean; gas?: number; failures?: number } {
    gasLog.push(body)
    const amount = BigInt(typeof body.gas === 'string' ? body.gas : '0')

    if (body.action === 'reserve-gas') {
        if (gasSpent + gasHeld + amount > rpc.gasBudget) return { allowed: false, gas: Number(gasSpent) }
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

        if (body.failure === true) gasFailures += 1

        return { allowed: true, gas: Number(gasSpent), failures: gasFailures }
    }

    if (body.action === 'enqueue-receipt') {
        return { allowed: true, gas: Number(gasSpent) }
    }

    return { allowed: false }
}

function poolFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const body = init?.body ? parseJson<PoolRequestBody>(String(init.body)) : {}

    if (url.includes('upgrade-rate-limit')) {
        if (
            body.action === 'reserve-gas' ||
            body.action === 'release-gas' ||
            body.action === 'settle-gas' ||
            body.action === 'enqueue-receipt'
        ) {
            if (rpc.gasThrow) return Promise.reject(new Error('gas budget down'))

            return Promise.resolve(jsonStub(applyGas(body)))
        }

        if (rpc.rateThrow) return Promise.reject(new Error('rate store down'))
        rateBodies.push(body)
        const now = Math.floor(Date.now() / 1000)

        const buckets = paidUpgradeRateBuckets({
            chainId: typeof body.chainId === 'number' ? body.chainId : CHAIN_ID,
            account: typeof body.account === 'string' ? body.account : 'unknown',
            ip: typeof body.ip === 'string' ? body.ip : 'unknown',
            includeGlobal: body.action === 'reserve' || body.action === 'release',
        })

        if (body.action === 'peek') {
            return Promise.resolve(jsonStub({ allowed: peekRateLimit(rateStore, buckets, now).allowed }))
        }

        if (body.action === 'release') {
            releaseRateLimit(
                rateStore,
                buckets,
                typeof body.reservedAt === 'number' ? body.reservedAt : now,
            )

            return Promise.resolve(jsonStub({ allowed: true }))
        }

        const decision = consumeRateLimit(rateStore, buckets, now)

        return Promise.resolve(jsonStub({ allowed: decision.allowed, reservedAt: now }))
    }

    if (rpc.failBroadcast) {
        return Promise.resolve(
            jsonStub(
                { error: 'broadcast failed', broadcastAttempted: rpc.broadcastAttempted },
                false,
            ),
        )
    }

    captures.push(body)

    return Promise.resolve(
        jsonStub({
            txHash: `0x${'ab'.repeat(32)}`,
            signer: '0x123',
            signerName: 'signer-8453-0',
        }),
    )
}

// Local contexts read these from env. Prod reads them from the deployments
// JSON, which the beforeAll below installs.
const ADDRESSES_8453 = {
    ORCHESTRATOR_8453: ORCHESTRATOR,
    SIMPLE_FUNDER_8453: '0x41D23D227C6D0F732D41eE5c203C48d96292A48B',
    SIMULATOR_8453: '0xDAD7c34d0c41698B227D3C5ee3d6d88A78c63a65',
    ACCOUNT_8453: '0x2eEBFfcFABEB8cE3AC016effFeC37dBBAccCff2a',
    ACCOUNT_PROXY_8453: ACCOUNT_PROXY,
    SIMPLE_SETTLER_8453: '0x5386d1026e1598177e03eA52cbF1a0994ADF5eaE',
    ESCROW_8453: '0x05f9597eed844410b7c0746A1C584188d0644730',
    MULTI_SIG_SIGNER_8453: '0xa3972FEebd6E1f973eD19cC586D79B3F61f892A3',
}

function createEnv(context = 'local'): Env {
    return testEnv({
        RPC_URL: 'http://rpc.test/8453',
        RPC_8453: 'http://rpc.test/8453',
        CHAIN_IDS: String(CHAIN_ID),
        CONTEXT: context,
        PAID_UPGRADE_ENABLED: 'true',
        RELAYER_COUNT: '1',
        QUOTE_SIGNING_SECRET: SECRET,
        ...ADDRESSES_8453,
        SIGNER_POOL: signerPoolWithFetch(poolFetch),
    })
}

function createCtx(ip?: string, context = 'local'): RpcContext {
    return {
        request: new Request('https://relayer.local/', {
            headers: ip ? { 'cf-connecting-ip': ip } : {},
        }),
        env: createEnv(context),
    }
}

async function signAuth(key: Hex, delegation: Address, nonce: number): Promise<Hex> {
    const account = privateKeyToAccount(key)

    return account.sign({
        hash: hashAuthorization({
            contractAddress: delegation,
            chainId: CHAIN_ID,
            nonce,
        }),
    })
}

async function signedPreCall(ownerKey: Hex): Promise<{
    eoa: Address
    executionData: Hex
    nonce: string
    signature: Hex
}> {
    const owner = privateKeyToAccount(ownerKey)
    const session = privateKeyToAccount(generatePrivateKey())
    const publicKey = encodeAbiParameters([{ type: 'address' }], [session.address])

    const { calls, executionData } = buildKeyInitializationData(
        [
            {
                expiry: '0',
                type: 'secp256k1',
                role: 'admin',
                publicKey,
                permissions: [],
            },
        ],
        owner.address,
    )

    const signature = await owner.signTypedData({
        domain: getSignedCallDomain(CHAIN_ID, ORCHESTRATOR),
        types: SIGNED_CALL_TYPES,
        primaryType: 'SignedCall',
        message: {
            multichain: false,
            eoa: owner.address,
            calls,
            nonce: UPGRADE_PRECALL_NONCE,
        },
    })

    return {
        eoa: owner.address,
        executionData,
        nonce: UPGRADE_PRECALL_NONCE.toString(),
        signature,
    }
}

async function signedParams(options?: {
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: string
    delegation?: Address
    authKey?: Hex
    intentSigner?: Hex
    txGas?: number
    maxFeePerGas?: number
    encodedPreCalls?: Hex[]
    mutateAfterSign?: (quote: Quote) => void
    echo?: Partial<PaidUpgradeQuote>
}): Promise<{ params: SendPreparedCallsParams; eoa: Address; upgrade: PaidUpgradeQuote }> {
    const eoa = privateKeyToAccount(OWNER_KEY).address
    const preCall = await signedPreCall(OWNER_KEY)
    const delegation = options?.delegation ?? ACCOUNT_PROXY

    const upgrade: PaidUpgradeQuote = {
        authorization: {
            contractAddress: delegation,
            chainId: CHAIN_ID,
            nonce: 0,
            signature: await signAuth(options?.authKey ?? OWNER_KEY, delegation, 0),
        },
        preCall,
    }

    const encoded = options?.encodedPreCalls ?? [encodeSignedPreCall(preCall)]
    const paymentToken = options?.paymentToken ?? USDC
    const txGas = options?.txGas ?? 100_000
    const maxFeePerGas = options?.maxFeePerGas ?? 1_000_000_000

    const paymentAmount = recomputeQuotePaymentAmount({
        txGas,
        maxFeePerGas,
        paymentToken,
        paymentTokenDecimals: 6,
        nativeRate: NATIVE_RATE,
    })

    const quote: Quote = {
        chainId: '0x2105',
        intent: {
            eoa,
            calls: [{ to: USDC, value: '0', data: '0x' }],
            nonce: '0',
            combinedGas: '500000',
            expiry: String(Math.floor(Date.now() / 1000) + 3600),
            encodedPreCalls: encoded,
            payer: options?.payer ?? eoa,
            paymentToken,
            paymentMaxAmount:
                options?.paymentMaxAmount ?? (paymentAmount > 0n ? paymentAmount.toString() : '1'),
        },
        orchestrator: ORCHESTRATOR,
        extraPayment: '0x0',
        ethPrice: '0x0',
        paymentTokenDecimals: 6,
        txGas,
        nativeFeeEstimate: {
            maxFeePerGas,
            maxPriorityFeePerGas: 1_000_000,
        },
        paymentAmount: '1',
        nativeRate: NATIVE_RATE,
        authSigner: eoa,
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
    options?.mutateAfterSign?.(quote)
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
            eoa: intent.eoa,
            calls: intent.calls.map((call) => ({
                to: call.to,
                value: BigInt(call.value || '0'),
                data: call.data,
            })),
            nonce: BigInt(intent.nonce),
            payer: intent.payer ?? zeroAddress,
            paymentToken: intent.paymentToken ?? zeroAddress,
            paymentMaxAmount: BigInt(intent.paymentMaxAmount ?? '0'),
            combinedGas: BigInt(intent.combinedGas),
            encodedPreCalls: intent.encodedPreCalls ?? emptyHex(),
            encodedFundTransfers: emptyHex(),
            settler: zeroAddress,
            expiry: BigInt(intent.expiry),
        },
    })

    const params: SendPreparedCallsParams = {
        context: { quote: signed },
        signature: await privateKeyToAccount(options?.intentSigner ?? OWNER_KEY).sign({
            hash: digest,
        }),
    }

    if (options?.echo) {
        params.accountUpgrade = options.echo
    }

    return {
        eoa,
        upgrade,
        params,
    }
}

function intentExecutedLog(err: Hex) {
    const eoa = privateKeyToAccount(OWNER_KEY).address

    return {
        address: ORCHESTRATOR,
        topics: encodeEventTopics({
            abi: orchestratorAbi,
            eventName: 'IntentExecuted',
            args: { eoa, nonce: 0n },
        }),
        data: encodeAbiParameters(
            [{ type: 'bool' }, { type: 'bytes4' }],
            [err === '0x00000000', err],
        ),
        logIndex: '0x0',
        transactionIndex: '0x0',
        transactionHash: `0x${'ab'.repeat(32)}`,
        blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x1',
        removed: false,
    }
}

function successReceipt() {
    return {
        transactionHash: `0x${'ab'.repeat(32)}`,
        transactionIndex: '0x0',
        blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x1',
        from: `0x${'11'.repeat(20)}`,
        to: ORCHESTRATOR,
        cumulativeGasUsed: rpc.receiptGas,
        gasUsed: rpc.receiptGas,
        contractAddress: null,
        logs: [intentExecutedLog(rpc.receiptErr)],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x1',
        effectiveGasPrice: '0x3b9aca00',
        type: '0x4',
    }
}

beforeEach(() => {
    captures = []
    rateBodies.length = 0
    gasLog.length = 0
    gasSpent = 0n
    gasHeld = 0n
    gasFailures = 0
    rateStore.clear()
    rpc.code = '0x'
    rpc.nonce = '0x0'
    rpc.balance = 20_000_000n
    rpc.executeResult = `0x${'0'.repeat(64)}`
    rpc.receiptErr = '0x00000000'
    rpc.receiptGas = '0x44444'
    rpc.rateThrow = false
    rpc.gasThrow = false
    rpc.failBroadcast = false
    rpc.broadcastAttempted = false
    rpc.gasBudget = 2_000_000n
    rpc.receiptMissing = false
    rpcCalls.length = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
            typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)

        if (!url.includes('rpc.test')) {
            throw new Error(`unexpected fetch ${url}`)
        }

        const raw = init?.body
            ? JSON.parse(String(init.body))
            : input instanceof Request
              ? await input.json()
              : {}

        const batch = Array.isArray(raw) ? raw : [raw]

        const results = batch.map((call: { id?: number; method?: string; params?: unknown[] }) => {
            rpcCalls.push(call)
            let result: unknown = '0x'

            type RpcTx = { authorizationList?: readonly object[]; from?: string }

            // SAFETY: this stub records the eth_call/send tx object the handler puts in params[0].
            const tx = call.params?.[0] as RpcTx | undefined

            if (call.method === 'eth_getCode') result = rpc.code
            else if (call.method === 'eth_getTransactionCount') result = rpc.nonce
            else if (call.method === 'eth_call' && tx?.authorizationList) result = rpc.executeResult
            else if (call.method === 'eth_call') result = word(rpc.balance)
            else if (call.method === 'eth_chainId') result = '0x2105'
            else if (call.method === 'eth_getTransactionReceipt') {
                if (rpc.receiptMissing) {
                    return {
                        jsonrpc: '2.0',
                        id: call.id ?? 1,
                        error: { code: -32000, message: 'receipt missing' },
                    }
                }

                result = successReceipt()
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

let restoreDeployment: () => void

beforeAll(() => {
    restoreDeployment = installDeployment('prod', CHAIN_ID, ADDRESSES_8453)
})

afterAll(() => restoreDeployment())

describe('paid upgrade send refusals', () => {
    it('attaches the quoted authorization and broadcasts once', async () => {
        const { params } = await signedParams()
        const result = await handleSendPreparedCalls(params, createCtx())
        expect(result.id).toEqual(expect.any(String))
        expect(captures).toHaveLength(1)

        type CapturedExecute = {
            type: string
            authorization: { address: string; chainId: number; nonce: number; r: Hex; s: Hex }
        }

        // SAFETY: poolFetch stores the execute-intent body this test just sent.
        const tx = captures[0] as CapturedExecute

        expect(tx.type).toBe('execute-intent')
        expect(tx.authorization.address).toBe(ACCOUNT_PROXY)
        expect(tx.authorization.chainId).toBe(CHAIN_ID)
        expect(tx.authorization.nonce).toBe(0)
        expect(tx.authorization.r).toMatch(/^0x[0-9a-fA-F]{64}$/)
        expect(tx.authorization.s).toMatch(/^0x[0-9a-fA-F]{64}$/)
    })

    it('refuses a zero fee in local', async () => {
        const { params } = await signedParams({ txGas: 0, maxFeePerGas: 0 })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade fee must be greater than zero',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a non-USDC fee token', async () => {
        const { params } = await signedParams({
            paymentToken: '0x0000000000000000000000000000000000000001',
        })

        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade requires the USDC fee token',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a payer that is not the account', async () => {
        const { params, eoa } = await signedParams({
            payer: '0x0000000000000000000000000000000000000002',
        })

        expect(eoa).not.toBe('0x0000000000000000000000000000000000000002')
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade payer must be the account',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses an authorization that was changed after the quote was signed', async () => {
        const { params } = await signedParams({
            mutateAfterSign: (quote) => {
                quote.accountUpgrade!.authorization.signature = `0x${'11'.repeat(65)}`
            },
        })

        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_QUOTE_SIGNATURE,
            message: 'Quote signature verification failed',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a pre-call encoding that was changed after the quote was signed', async () => {
        const { params } = await signedParams({
            mutateAfterSign: (quote) => {
                quote.intent.encodedPreCalls = ['0x1234']
            },
        })

        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_QUOTE_SIGNATURE,
            message: 'Quote signature verification failed',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses an echoed upgrade that differs from the signed quote', async () => {
        const { params, upgrade } = await signedParams()

        const echoed = {
            ...upgrade,
            authorization: { ...upgrade.authorization, nonce: 1 },
        }

        const withEcho = { ...params, accountUpgrade: echoed }
        await expect(handleSendPreparedCalls(withEcho, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Authorization or pre-call does not match the quote',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a delegation that is not the account proxy', async () => {
        const { params } = await signedParams({
            delegation: '0x000000000000000000000000000000000000dEaD',
        })

        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Delegation target is not the account proxy',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses an authorization signed by someone other than the account', async () => {
        const { params } = await signedParams({ authKey: OTHER_KEY })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_SIGNATURE,
            message: 'Invalid authorization signature',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses an account that does not have the quoted USDC', async () => {
        rpc.balance = 0n
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INSUFFICIENT_FUNDS,
            message: 'Insufficient USDC balance',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a paymentMaxAmount above the cap', async () => {
        const { params } = await signedParams({ paymentMaxAmount: '10000001' })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade paymentMaxAmount exceeds cap',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a flat 10 USDC cap above the 5 USDC ceiling', async () => {
        const { params } = await signedParams({ paymentMaxAmount: '10000000' })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade paymentMaxAmount exceeds cap',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a paymentMaxAmount above the quoted fee plus 5%', async () => {
        const { params } = await signedParams({ paymentMaxAmount: '400000' })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade paymentMaxAmount exceeds the quoted fee cap',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses an intent signed by someone other than the account', async () => {
        const { params } = await signedParams({ intentSigner: OTHER_KEY })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_SIGNATURE,
            message: 'Intent signer is not the account',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a simulation that stores PaymentError', async () => {
        rpc.executeResult = '0xabab8fc900000000000000000000000000000000000000000000000000000000'
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INSUFFICIENT_FUNDS,
            message: 'Paid upgrade simulation failed: PaymentError',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a simulation that stores VerificationError', async () => {
        rpc.executeResult = '0xfbcb0b3400000000000000000000000000000000000000000000000000000000'
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_SIGNATURE,
            message: 'Paid upgrade simulation failed: VerificationError',
        })
        expect(captures).toHaveLength(0)
    })

    it('counts a PaymentError success receipt against the gas budget', async () => {
        rpc.receiptErr = '0xabab8fc9'
        rpc.receiptGas = '0xec3e'
        const { params } = await signedParams()
        const result = await handleSendPreparedCalls(params, createCtx())
        expect(result.id).toEqual(expect.any(String))
        expect(captures).toHaveLength(1)
        expect(gasFailures).toBe(1)
        expect(gasSpent).toBe(60_478n)
        expect(gasLog.some((entry) => entry.action === 'settle-gas' && entry.failure === true)).toBe(
            true,
        )
    })

    it('refuses a send once the daily gas budget is spent', async () => {
        rpc.gasBudget = 1n
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: RATE_LIMITED,
            message: 'Paid upgrade gas budget exceeded',
        })
        expect(captures).toHaveLength(0)
    })

    it('fails closed when the gas budget store is down', async () => {
        rpc.gasThrow = true
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: SERVICE_UNAVAILABLE,
        })
        expect(captures).toHaveLength(0)
    })

    it('releases the gas hold when the broadcast never lands', async () => {
        rpc.failBroadcast = true
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: SERVICE_UNAVAILABLE,
        })
        expect(captures).toHaveLength(0)
        expect(gasLog.map((entry) => entry.action)).toEqual(['reserve-gas', 'release-gas'])
        expect(gasHeld).toBe(0n)
    })

    it('settles the full hold as spent gas when a broadcast may have been attempted', async () => {
        rpc.failBroadcast = true
        rpc.broadcastAttempted = true
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toThrow('broadcast failed')
        expect(captures).toHaveLength(0)
        expect(gasLog.map((entry) => entry.action)).toEqual(['reserve-gas', 'settle-gas'])
        expect(gasLog[1]).toMatchObject({ hold: '500000', gas: '500000', failure: false })
        expect(gasLog[1]?.txHash).toBeUndefined()
        expect(gasHeld).toBe(0n)
        expect(gasSpent).toBe(500_000n)
    })

    it('simulates the execute from the relayer signer that will broadcast', async () => {
        const { params } = await signedParams()
        await handleSendPreparedCalls(params, createCtx('203.0.113.50'))

        type RpcTx = { authorizationList?: readonly object[]; from?: string }

        const exec = rpcCalls.find((call) => {
            // SAFETY: this stub records the eth_call tx object the handler puts in params[0].
            const tx = call.params?.[0] as RpcTx | undefined

            return call.method === 'eth_call' && tx?.authorizationList !== undefined
        })

        // SAFETY: the matching eth_call's first param is the tx the handler simulated.
        const tx = exec?.params?.[0] as RpcTx | undefined
        expect(tx?.from?.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
    })

    it('refuses a paid upgrade with no client IP outside local', async () => {
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx(undefined, 'prod'))).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade client IP is required',
        })
        expect(captures).toHaveLength(0)
        expect(gasLog).toHaveLength(0)
    })

    it('keeps a missing client IP on the local unknown bucket', async () => {
        const { params } = await signedParams()
        await handleSendPreparedCalls(params, createCtx())
        expect(rateBodies.some((body) => body.ip === 'unknown' && body.action === 'reserve')).toBe(
            true,
        )
    })

    it('queues a missed receipt so the gas hold can be reconciled', async () => {
        rpc.receiptMissing = true
        const { params } = await signedParams()

        const env = createEnv()
        env.PAID_UPGRADE_RECEIPT_WAIT_MS = '200'

        const ctx: RpcContext = {
            request: new Request('https://relayer.local/', {
                headers: { 'cf-connecting-ip': '203.0.113.50' },
            }),
            env,
        }

        const result = await handleSendPreparedCalls(params, ctx)
        expect(result.id).toEqual(expect.any(String))
        expect(gasHeld).toBe(500_000n)
        expect(gasLog.map((entry) => entry.action)).toEqual(['reserve-gas', 'enqueue-receipt'])
        expect(gasLog[1]?.txHash).toBe(`0x${'ab'.repeat(32)}`)
    }, 25_000)

    it('sends the caller IP into the paid rate buckets', async () => {
        const { params } = await signedParams()
        await handleSendPreparedCalls(params, createCtx('203.0.113.50'))
        expect(rateBodies.some((body) => body.ip === '203.0.113.50')).toBe(true)
    })

    it('caps one IPv6 /56 and the chain, not only the address', () => {
        const buckets = paidUpgradeRateBuckets({
            chainId: CHAIN_ID,
            account: '0xabc',
            ip: '2001:db8:1:2::',
            includeGlobal: true,
        })

        expect(buckets.map((bucket) => bucket.key)).toEqual([
            `paid-upgrade:address:${CHAIN_ID}:0xabc`,
            `paid-upgrade:ip:${CHAIN_ID}:2001:db8:1:2::`,
            `paid-upgrade:ip56:${CHAIN_ID}:2001:db8:1::`,
            `paid-upgrade:global:${CHAIN_ID}`,
        ])
        expect(buckets.find((bucket) => bucket.key.includes(':ip56:'))?.limit).toBe(8)
        expect(buckets.find((bucket) => bucket.key.includes(':global:'))?.limit).toBe(60)
        const store = new Map<string, number>()
        const now = 1_700_000_000

        for (let index = 0; index < 8; index++) {
            const decision = consumeRateLimit(
                store,
                paidUpgradeRateBuckets({
                    chainId: CHAIN_ID,
                    account: `0x${index.toString(16).padStart(40, '0')}`,
                    ip: index % 2 === 0 ? '2001:db8:1:2::' : '2001:db8:1:3::',
                }),
                now,
            )

            expect(decision.allowed).toBe(true)
        }

        expect(
            consumeRateLimit(
                store,
                paidUpgradeRateBuckets({
                    chainId: CHAIN_ID,
                    account: `0x${'f'.repeat(40)}`,
                    ip: '2001:db8:1:9::',
                }),
                now,
            ).allowed,
        ).toBe(false)
    })

    it('refuses the 9th send from one IP', () => {
        const now = 1_700_000_000
        const store = new Map<string, number>()

        for (let index = 0; index < 8; index++) {
            const decision = consumeRateLimit(
                store,
                paidUpgradeRateBuckets({
                    chainId: CHAIN_ID,
                    account: `0x${(index + 1).toString(16).padStart(40, '0')}`,
                    ip: '203.0.113.8',
                }),
                now,
            )

            expect(decision.allowed).toBe(true)
        }

        expect(
            consumeRateLimit(
                store,
                paidUpgradeRateBuckets({
                    chainId: CHAIN_ID,
                    account: `0x${'a'.repeat(40)}`,
                    ip: '203.0.113.8',
                }),
                now,
            ).allowed,
        ).toBe(false)
        expect(
            consumeRateLimit(
                store,
                paidUpgradeRateBuckets({
                    chainId: CHAIN_ID,
                    account: `0x${'b'.repeat(40)}`,
                    ip: '203.0.113.9',
                }),
                now,
            ).allowed,
        ).toBe(true)
    })

    it('counts only sends toward the chain ceiling of 60', () => {
        const now = 1_700_000_000

        const prepareBuckets = paidUpgradeRateBuckets({
            chainId: CHAIN_ID,
            account: '0xabc',
            ip: '203.0.113.1',
            includeGlobal: false,
        })

        const sendBuckets = paidUpgradeRateBuckets({
            chainId: CHAIN_ID,
            account: '0xabc',
            ip: '203.0.113.1',
            includeGlobal: true,
        })

        const prepareStore = new Map<string, number>()
        let preparesAllowed = 0

        for (let index = 0; index < 60; index++) {
            const allowed = consumeRateLimit(
                prepareStore,
                paidUpgradeRateBuckets({
                    chainId: CHAIN_ID,
                    account: `0x${(index + 1).toString(16).padStart(40, '0')}`,
                    ip: `203.0.${index}.1`,
                    includeGlobal: false,
                }),
                now,
            ).allowed

            if (allowed) preparesAllowed += 1
        }

        const sendStore = new Map<string, number>()
        let sendsAllowed = 0

        for (let index = 0; index < 60; index++) {
            const allowed = consumeRateLimit(
                sendStore,
                paidUpgradeRateBuckets({
                    chainId: CHAIN_ID,
                    account: `0x${(index + 1).toString(16).padStart(40, 'a')}`,
                    ip: `198.51.${index}.1`,
                    includeGlobal: true,
                }),
                now,
            ).allowed

            if (allowed) sendsAllowed += 1
        }

        const sixtyFirst = consumeRateLimit(
            sendStore,
            paidUpgradeRateBuckets({
                chainId: CHAIN_ID,
                account: `0x${'cd'.repeat(20)}`,
                ip: '198.51.100.200',
                includeGlobal: true,
            }),
            now,
        ).allowed

        expect({
            prepareHasGlobal: prepareBuckets.some((bucket) => bucket.key.includes(':global:')),
            limit: sendBuckets.find((bucket) => bucket.key.includes(':global:'))?.limit,
            preparesAllowed,
            sendsAllowed,
            sixtyFirst,
        }).toEqual({
            prepareHasGlobal: false,
            limit: 60,
            preparesAllowed: 60,
            sendsAllowed: 60,
            sixtyFirst: false,
        })
    })

    it('does not sign a quote when the paid rate-limit commit is rejected', async () => {
        const env = createEnv()
        const account = privateKeyToAccount(OWNER_KEY).address

        for (let attempt = 0; attempt < PAID_UPGRADE_ADDRESS_LIMIT; attempt++) {
            await recordPaidUpgradeRateLimit(env, CHAIN_ID, account, '203.0.113.8')
        }

        await expect(
            recordPaidUpgradeRateLimit(env, CHAIN_ID, account, '203.0.113.8'),
        ).rejects.toMatchObject({
            code: RATE_LIMITED,
            message: 'Paid upgrade rate limit exceeded',
        })
    })

    it('fails closed when the paid rate-limit commit cannot be stored', async () => {
        rpc.rateThrow = true
        const env = createEnv()
        await expect(
            recordPaidUpgradeRateLimit(
                env,
                CHAIN_ID,
                privateKeyToAccount(OWNER_KEY).address,
                '203.0.113.8',
            ),
        ).rejects.toMatchObject({
            code: SERVICE_UNAVAILABLE,
        })
    })

    it('refuses the address after the per-address window is full', async () => {
        const { params } = await signedParams()
        const ctx = createCtx()

        for (let i = 0; i < PAID_UPGRADE_ADDRESS_LIMIT; i++) {
            await handleSendPreparedCalls(params, ctx)
        }

        expect(captures).toHaveLength(PAID_UPGRADE_ADDRESS_LIMIT)
        await expect(handleSendPreparedCalls(params, ctx)).rejects.toMatchObject({
            code: RATE_LIMITED,
            message: 'Paid upgrade rate limit exceeded',
        })
        expect(captures).toHaveLength(PAID_UPGRADE_ADDRESS_LIMIT)
    })

    it('does not batch a paid upgrade', async () => {
        const { params } = await signedParams()
        const results = await handleBatchSendPreparedCalls([{ id: 1, params }], createCtx())
        expect(results[0]?.error).toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade cannot be batched',
        })
        expect(captures).toHaveLength(0)
    })
})
