/**
 * User-paid first EIP-7702 upgrade through wallet_sendPreparedCalls.
 * These cases refuse on the paid path. A quote with no accountUpgrade still
 * takes the existing execute-intent path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, zeroAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hashAuthorization, hashTypedData } from 'viem/utils'
import { orchestratorAbi } from '@nubl/contracts/abis'

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
import {
    buildKeyInitializationData,
    getSignedCallDomain,
    SIGNED_CALL_TYPES,
    UPGRADE_PRECALL_NONCE,
} from '../../src/rpc/methods/shared/account-helpers'
import {
    encodeSignedPreCall,
    eip7702DelegationCode,
    PAID_UPGRADE_ADDRESS_LIMIT,
    PAID_UPGRADE_GAS_HOLD,
    capPaidUpgradeSignedGas,
    paidUpgradeRateBuckets,
    recordPaidUpgradeRateLimit,
    signedPaymentMaxForQuote,
} from '../../src/rpc/methods/shared/paid-upgrade'
import {
    paidUpgradeFeeNonce,
    paidUpgradeFeeTypedData,
    type PaidUpgradeFeeRecord,
} from '../../src/rpc/schema/paid-upgrade-fee'
import {
    consumeRateLimit,
    peekRateLimit,
    releaseRateLimit,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'

const CHAIN_ID = 8453
const SECRET = 'paid-upgrade-test-secret'
const FEE_RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const PULL_HASH = `0x${'11'.repeat(32)}` as Hex
const UPGRADE_HASH = `0x${'ab'.repeat(32)}` as Hex
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const ACCOUNT_PROXY = '0x3Be52867f8Dca2911f81076B37921c334dE29551' as Address
const ORCHESTRATOR = '0xcf96B5228f656f26f83B8f1240fAD544C17ac7a8' as Address
const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const OTHER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e141207b4c24b44a4361' as Hex
const NATIVE_RATE = (3000n * 10n ** 18n).toString()

const rpc = {
    code: '0x',
    nonce: '0x0',
    balance: 20_000_000n,
    executeResult: `0x${'0'.repeat(64)}` as Hex,
    receiptErr: '0x00000000' as Hex,
    receiptGas: '0x44444' as Hex,
    rateThrow: false,
    gasThrow: false,
    failBroadcast: false,
    gasBudget: 2_000_000n,
    pullReverts: false,
    authUsed: false,
    upgradeRevertRemaining: 0,
    receiptMissing: false,
}

const gasLog: Array<Record<string, unknown>> = []
let gasSpent = 0n
let gasHeld = 0n
let gasFailures = 0

function word(value: bigint): Hex {
    return `0x${value.toString(16).padStart(64, '0')}` as Hex
}

function jsonResponse(body: unknown, ok = true): Response {
    return {
        ok,
        json: async () => body,
    } as Response
}

let captures: Array<Record<string, unknown>> = []
const rpcCalls: Array<{ method?: string; params?: unknown[] }> = []
const rateBodies: Array<Record<string, unknown>> = []
const rateStore = new Map<string, number>()
const feeStore = new Map<string, PaidUpgradeFeeRecord>()
const feeLog: PaidUpgradeFeeRecord[] = []

function applyFee(body: Record<string, unknown>): { allowed: boolean; inserted?: boolean; record: PaidUpgradeFeeRecord | null } {
    const quoteKey = typeof body.quoteKey === 'string' ? body.quoteKey : ''
    const record = body.record as PaidUpgradeFeeRecord | undefined
    if (body.action === 'get') {
        return { allowed: true, record: feeStore.get(quoteKey) ?? null }
    }
    if (body.action === 'delete') {
        feeStore.delete(quoteKey)
        return { allowed: true, record: null }
    }
    if (body.action === 'insert') {
        const existing = feeStore.get(quoteKey)
        if (existing) return { allowed: true, inserted: false, record: existing }
        if (!record) return { allowed: false, record: null }
        feeStore.set(quoteKey, record)
        feeLog.push({ ...record })
        return { allowed: true, inserted: true, record }
    }
    if (body.action === 'update') {
        if (!feeStore.has(quoteKey) || !record) return { allowed: true, record: null }
        feeStore.set(quoteKey, record)
        feeLog.push({ ...record })
        return { allowed: true, record }
    }
    return { allowed: false, record: null }
}

function applyGas(body: Record<string, unknown>): { allowed: boolean; gas?: number; failures?: number } {
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
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.includes('upgrade-rate-limit')) {
        if (body.action === 'fits-gas') {
            if (rpc.gasThrow) return Promise.reject(new Error('gas budget down'))
            const amount = BigInt(typeof body.gas === 'string' ? body.gas : '0')
            return Promise.resolve(
                jsonResponse({
                    allowed: gasSpent + gasHeld + amount <= rpc.gasBudget,
                    gas: Number(gasSpent),
                }),
            )
        }
        if (
            body.action === 'reserve-gas' ||
            body.action === 'release-gas' ||
            body.action === 'settle-gas' ||
            body.action === 'enqueue-receipt'
        ) {
            if (rpc.gasThrow) return Promise.reject(new Error('gas budget down'))
            return Promise.resolve(jsonResponse(applyGas(body)))
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
    if (url.includes('paid-upgrade-fee')) {
        return Promise.resolve(jsonResponse(applyFee(body)))
    }
    if (rpc.failBroadcast) {
        return Promise.resolve(
            jsonResponse({ error: 'broadcast failed', broadcastAttempted: false }, false),
        )
    }
    captures.push(body)
    const txHash = body.type === 'pull-paid-upgrade-fee' ? PULL_HASH : UPGRADE_HASH
    return Promise.resolve(
        jsonResponse({
            txHash,
            signer: '0x123',
            signerName: 'signer-8453-0',
        }),
    )
}

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

function createCtx(ip?: string, context = 'local'): RpcContext {
    return {
        request: new Request('https://relayer.local/', {
            headers: ip ? { 'cf-connecting-ip': ip } : {},
        }),
        env: {
            RPC_URL: 'http://rpc.test/8453',
            RPC_8453: 'http://rpc.test/8453',
            CHAIN_IDS: String(CHAIN_ID),
            CONTEXT: context,
            RELAYER_MNEMONIC: TEST_MNEMONIC,
            RELAYER_COUNT: '1',
            QUOTE_SIGNING_SECRET: SECRET,
            FEE_RECIPIENT,
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
    callData?: Hex
    mutateAfterSign?: (quote: Quote) => void
    echo?: Partial<PaidUpgradeQuote>
    fee?: 'default' | 'omit' | 'expired' | 'replay-nonce' | 'redirect-value' | 'redirect-to' | 'wrong-payee-sig'
    feeFrom?: { signature: Hex; ttl: number; value: bigint }
}): Promise<{ params: unknown; eoa: Address; upgrade: PaidUpgradeQuote; payment: bigint; fee: bigint }> {
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
            calls: [{ to: USDC, value: '0', data: options?.callData ?? '0x' }],
            nonce: '0',
            combinedGas: '500000',
            expiry: String(Math.floor(Date.now() / 1000) + 3600),
            encodedPreCalls: encoded,
            payer: options?.payer ?? eoa,
            paymentToken,
            paymentMaxAmount:
                options?.paymentMaxAmount ??
                (paymentAmount > 0n ? signedPaymentMaxForQuote(paymentAmount).toString() : '1'),
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
        paymentAmount: paymentAmount.toString(),
        nativeRate: NATIVE_RATE,
        authSigner: eoa,
        feeTokenDeficit: '0x0',
        assetDeficits: [],
        feeRecipient: FEE_RECIPIENT,
        accountUpgrade: upgrade,
    }
    const signed: SignedQuotes = {
        quotes: [quote],
        signature: '0x',
        ttl: Math.floor(Date.now() / 1000) + 300,
    }
    signed.signature = await signQuotes(signed, SECRET)
    options?.mutateAfterSign?.(quote)
    const feeValue = signedPaymentMaxForQuote(paymentAmount)
    let feeAuthorization: {
        validAfter: string
        validBefore: string
        nonce: Hex
        signature: Hex
    } | undefined
    if (options?.fee !== 'omit' && paymentAmount > 0n) {
        const mode = options?.fee ?? 'default'
        const otherPayee = '0x00000000000000000000000000000000000000ab' as Address
        const signedTo = mode === 'redirect-to' || mode === 'wrong-payee-sig' ? otherPayee : FEE_RECIPIENT
        const signedValue = mode === 'redirect-value' ? feeValue + 1n : feeValue
        const nonce =
            mode === 'replay-nonce'
                ? (`0x${'22'.repeat(32)}` as Hex)
                : paidUpgradeFeeNonce({
                      quoteSignature: options?.feeFrom?.signature ?? signed.signature,
                      chainId: CHAIN_ID,
                      from: eoa,
                      to: mode === 'redirect-to' ? otherPayee : FEE_RECIPIENT,
                      value:
                          mode === 'redirect-value'
                              ? feeValue + 1n
                              : (options?.feeFrom?.value ?? feeValue),
                  })
        const validBefore = mode === 'expired' ? 1n : BigInt(signed.ttl)
        const signature = await privateKeyToAccount(OWNER_KEY).signTypedData(
            paidUpgradeFeeTypedData({
                chainId: CHAIN_ID,
                token: USDC,
                from: eoa,
                to: signedTo,
                value: signedValue,
                validAfter: 0n,
                validBefore,
                nonce,
            }),
        )
        feeAuthorization = {
            validAfter: '0',
            validBefore: validBefore.toString(),
            nonce,
            signature,
        }
    }
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
            payer: (intent.payer ?? zeroAddress) as Address,
            paymentToken: (intent.paymentToken ?? zeroAddress) as Address,
            paymentMaxAmount: BigInt(intent.paymentMaxAmount ?? '0'),
            combinedGas: BigInt(intent.combinedGas),
            encodedPreCalls: (intent.encodedPreCalls ?? []) as Hex[],
            encodedFundTransfers: [] as Hex[],
            settler: zeroAddress,
            expiry: BigInt(intent.expiry),
        },
    })
    return {
        eoa,
        upgrade,
        payment: paymentAmount,
        fee: feeValue,
        params: {
            context: { quote: signed },
            signature: await privateKeyToAccount(options?.intentSigner ?? OWNER_KEY).sign({
                hash: digest,
            }),
            ...(options?.echo ? { accountUpgrade: options.echo } : {}),
            ...(feeAuthorization ? { feeAuthorization } : {}),
        },
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

function transferLog(value: bigint) {
    const pull = [...captures].reverse().find((body) => body.type === 'pull-paid-upgrade-fee')
    const from = (pull?.from as Address | undefined) ?? privateKeyToAccount(OWNER_KEY).address
    const to = (pull?.to as Address | undefined) ?? FEE_RECIPIENT
    return {
        address: USDC,
        topics: encodeEventTopics({
            abi: [
                {
                    type: 'event',
                    name: 'Transfer',
                    inputs: [
                        { name: 'from', type: 'address', indexed: true },
                        { name: 'to', type: 'address', indexed: true },
                        { name: 'value', type: 'uint256', indexed: false },
                    ],
                },
            ],
            eventName: 'Transfer',
            args: { from, to, value },
        }),
        data: word(value),
        logIndex: '0x0',
        transactionIndex: '0x0',
        transactionHash: PULL_HASH,
        blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x1',
        removed: false,
    }
}

function pullReceipt() {
    const pull = [...captures].reverse().find((body) => body.type === 'pull-paid-upgrade-fee')
    const value = BigInt(typeof pull?.value === 'string' ? pull.value : '0')
    return {
        transactionHash: PULL_HASH,
        transactionIndex: '0x0',
        blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x1',
        from: FEE_RECIPIENT,
        to: USDC,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: rpc.pullReverts ? [] : [transferLog(value)],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: rpc.pullReverts ? '0x0' : '0x1',
        effectiveGasPrice: '0x3b9aca00',
        type: '0x2',
    }
}

function successReceipt() {
    const revert = rpc.upgradeRevertRemaining > 0
    if (revert) rpc.upgradeRevertRemaining -= 1
    return {
        transactionHash: UPGRADE_HASH,
        transactionIndex: '0x0',
        blockHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '0x1',
        from: `0x${'11'.repeat(20)}`,
        to: ORCHESTRATOR,
        cumulativeGasUsed: rpc.receiptGas,
        gasUsed: rpc.receiptGas,
        contractAddress: null,
        logs: revert ? [] : [intentExecutedLog(rpc.receiptErr)],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: revert ? '0x0' : '0x1',
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
    feeLog.length = 0
    rpc.code = '0x'
    rpc.nonce = '0x0'
    rpc.balance = 20_000_000n
    rpc.executeResult = `0x${'0'.repeat(64)}`
    rpc.receiptErr = '0x00000000'
    rpc.receiptGas = '0x44444'
    rpc.rateThrow = false
    rpc.gasThrow = false
    rpc.failBroadcast = false
    rpc.gasBudget = 2_000_000n
    rpc.pullReverts = false
    rpc.authUsed = false
    rpc.upgradeRevertRemaining = 0
    rpc.receiptMissing = false
    feeStore.clear()
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
            const tx = call.params?.[0] as {
                authorizationList?: unknown
                data?: string
                to?: string
                from?: string
            } | undefined
            if (call.method === 'eth_getCode') result = rpc.code
            else if (call.method === 'eth_getTransactionCount') result = rpc.nonce
            else if (call.method === 'eth_call' && tx?.to?.toLowerCase() === ORCHESTRATOR.toLowerCase()) {
                result = rpc.executeResult
            } else if (call.method === 'eth_call' && tx?.authorizationList) result = rpc.executeResult
            else if (call.method === 'eth_call' && tx?.data?.startsWith('0xe94a0102')) {
                result = word(rpc.authUsed ? 1n : 0n)
            } else if (call.method === 'eth_call') result = word(rpc.balance)
            else if (call.method === 'eth_chainId') result = '0x2105'
            else if (call.method === 'eth_getTransactionReceipt') {
                if (rpc.receiptMissing && call.params?.[0] !== PULL_HASH) {
                    return {
                        jsonrpc: '2.0',
                        id: call.id ?? 1,
                        error: { code: -32000, message: 'receipt missing' },
                    }
                }
                result = call.params?.[0] === PULL_HASH ? pullReceipt() : successReceipt()
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

describe('paid upgrade send refusals', () => {
    it('attaches the quoted authorization and broadcasts once', async () => {
        const { params, fee } = await signedParams()
        const result = await handleSendPreparedCalls(params, createCtx())
        expect(result.id).toEqual(expect.any(String))
        const pulls = captures.filter((body) => body.type === 'pull-paid-upgrade-fee')
        const upgrades = captures.filter((body) => body.type === 'execute-intent')
        expect(pulls).toHaveLength(1)
        expect(upgrades).toHaveLength(1)
        expect(pulls[0]?.to).toBe(FEE_RECIPIENT)
        expect(pulls[0]?.value).toBe(fee.toString())
        const tx = upgrades[0] as {
            type: string
            intent: { paymentAmount: string }
            authorization: { address: string; chainId: number; nonce: number; r: Hex; s: Hex }
        }
        expect(tx.type).toBe('execute-intent')
        expect(tx.intent.paymentAmount).toBe('0')
        expect(tx.authorization.address).toBe(ACCOUNT_PROXY)
        expect(tx.authorization.chainId).toBe(CHAIN_ID)
        expect(tx.authorization.nonce).toBe(0)
        expect(tx.authorization.r).toMatch(/^0x[0-9a-fA-F]{64}$/)
        expect(tx.authorization.s).toMatch(/^0x[0-9a-fA-F]{64}$/)
        expect(gasLog.filter((entry) => entry.action === 'settle-gas')).toHaveLength(2)
        expect(gasSpent).toBe(21_000n + 279_620n)
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
        const withEcho = { ...(params as object), accountUpgrade: echoed }
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
        expect(captures.filter((body) => body.type === 'execute-intent')).toHaveLength(1)
        expect(captures.filter((body) => body.type === 'pull-paid-upgrade-fee')).toHaveLength(1)
        expect(gasFailures).toBe(1)
        expect(gasSpent).toBe(21_000n + 60_478n)
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
        expect(gasLog.filter((entry) => entry.action === 'reserve-gas')).toHaveLength(0)
    })

    it('refuses the pull before reserving when the hold does not fit the daily budget', async () => {
        gasSpent = 1_600_000n
        const { params } = await signedParams({ callData: '0xbd' })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: RATE_LIMITED,
            message: 'Paid upgrade gas budget exceeded',
        })
        expect(captures).toHaveLength(0)
        expect(gasLog).toEqual([])
        expect(gasHeld).toBe(0n)
        expect(gasSpent).toBe(1_600_000n)
        expect(feeStore.size).toBe(0)
        expect(rateBodies.some((body) => body.action === 'reserve')).toBe(true)
        expect(rateBodies.some((body) => body.action === 'release')).toBe(true)
    })

    it('caps the signed pull gas at the reservation', () => {
        expect(capPaidUpgradeSignedGas(600_000n)).toBe(PAID_UPGRADE_GAS_HOLD)
        expect(capPaidUpgradeSignedGas(84_541n)).toBe(84_541n)
        expect(capPaidUpgradeSignedGas(PAID_UPGRADE_GAS_HOLD)).toBe(PAID_UPGRADE_GAS_HOLD)
        expect(() => capPaidUpgradeSignedGas(0n)).toThrow(/gas limit exceeds cap/)
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

    it('simulates the execute from the relayer signer that will broadcast', async () => {
        const { params } = await signedParams()
        await handleSendPreparedCalls(params, createCtx('203.0.113.50'))
        const exec = rpcCalls.find((call) => {
            const tx = call.params?.[0] as { authorizationList?: unknown } | undefined
            return call.method === 'eth_call' && tx?.authorizationList !== undefined
        })
        const tx = exec?.params?.[0] as { from?: string } | undefined
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
        const ctx = createCtx('203.0.113.50')
        ;(ctx.env as Env).PAID_UPGRADE_RECEIPT_WAIT_MS = '200'
        const result = await handleSendPreparedCalls(params, ctx)
        expect(result.id).toEqual(expect.any(String))
        expect(gasHeld).toBe(500_000n)
        expect(gasLog.map((entry) => entry.action)).toEqual([
            'reserve-gas',
            'settle-gas',
            'reserve-gas',
            'enqueue-receipt',
        ])
        expect(gasLog.at(-1)?.txHash).toBe(UPGRADE_HASH)
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
        const env = createCtx().env as Env
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
        const env = createCtx().env as Env
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
        const ctx = createCtx()
        for (let i = 0; i < PAID_UPGRADE_ADDRESS_LIMIT; i++) {
            const { params } = await signedParams({ callData: `0x${i.toString(16).padStart(2, '0')}` })
            await handleSendPreparedCalls(params, ctx)
        }
        expect(captures.filter((body) => body.type === 'execute-intent')).toHaveLength(
            PAID_UPGRADE_ADDRESS_LIMIT,
        )
        const blocked = await signedParams({ callData: '0xabcdef' })
        await expect(handleSendPreparedCalls(blocked.params, ctx)).rejects.toMatchObject({
            code: RATE_LIMITED,
            message: 'Paid upgrade rate limit exceeded',
        })
        expect(captures.filter((body) => body.type === 'execute-intent')).toHaveLength(
            PAID_UPGRADE_ADDRESS_LIMIT,
        )
    })

    it('refuses a sweep that leaves less than the clamped fee and does not pull', async () => {
        const { payment, fee } = await signedParams()
        expect(fee).toBeGreaterThan(payment)
        rpc.balance = payment
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INSUFFICIENT_FUNDS,
            message: 'Insufficient USDC balance',
        })
        expect(captures).toHaveLength(0)
        expect(gasSpent).toBe(0n)
        expect(gasLog).toHaveLength(0)
    })

    it('does not broadcast the upgrade when the fee pull reverts', async () => {
        rpc.pullReverts = true
        const { params } = await signedParams()
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: SERVICE_UNAVAILABLE,
            message: 'Paid upgrade fee pull failed',
        })
        expect(captures.filter((body) => body.type === 'pull-paid-upgrade-fee')).toHaveLength(1)
        expect(captures.filter((body) => body.type === 'execute-intent')).toHaveLength(0)
        expect(gasFailures).toBe(1)
        expect(gasSpent).toBe(21_000n)
        expect([...feeStore.values()][0]?.status).toBe('pull_failed')
    })

    it('refuses an authorization nonce that belongs to another quote', async () => {
        const first = await signedParams({ callData: '0x01' })
        const second = await signedParams({
            callData: '0x02',
            feeFrom: {
                signature: (first.params as { context: { quote: { signature: Hex } } }).context.quote
                    .signature,
                ttl: 0,
                value: first.fee,
            },
        })
        await expect(handleSendPreparedCalls(second.params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade fee nonce does not match the quote',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses a reused authorization nonce', async () => {
        const { params } = await signedParams({ fee: 'replay-nonce' })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade fee nonce does not match the quote',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses an authorization signed for a different value', async () => {
        const { params } = await signedParams({ fee: 'redirect-value' })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade fee nonce does not match the quote',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses an authorization signed for a different payee', async () => {
        const { params } = await signedParams({ fee: 'redirect-to' })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade fee nonce does not match the quote',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses an authorization whose signature pays a different address', async () => {
        const { params } = await signedParams({ fee: 'wrong-payee-sig' })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_SIGNATURE,
            message: 'Paid upgrade fee signer is not the account',
        })
        expect(captures).toHaveLength(0)
    })

    it('refuses an expired fee authorization', async () => {
        const { params } = await signedParams({ fee: 'expired' })
        await expect(handleSendPreparedCalls(params, createCtx())).rejects.toMatchObject({
            code: INVALID_PARAMS,
            message: 'Paid upgrade fee authorization expired',
        })
        expect(captures).toHaveLength(0)
    })

    it('retries the upgrade after a reverted inclusion and does not pull again', async () => {
        rpc.upgradeRevertRemaining = 1
        const { params, fee } = await signedParams()
        const ctx = createCtx()
        await expect(handleSendPreparedCalls(params, ctx)).rejects.toMatchObject({
            message: 'Paid upgrade was not included; retry will not charge the fee again',
        })
        expect(captures.filter((body) => body.type === 'pull-paid-upgrade-fee')).toHaveLength(1)
        expect(captures.filter((body) => body.type === 'execute-intent')).toHaveLength(1)
        expect([...feeStore.values()][0]?.status).toBe('upgrade_failed')
        const spentAfterFailure = gasSpent
        expect(gasFailures).toBe(1)

        const retried = await handleSendPreparedCalls(params, ctx)
        expect(retried.id).toEqual(expect.any(String))
        expect(captures.filter((body) => body.type === 'pull-paid-upgrade-fee')).toHaveLength(1)
        expect(captures.filter((body) => body.type === 'execute-intent')).toHaveLength(2)
        expect(captures.filter((body) => body.type === 'pull-paid-upgrade-fee')[0]?.value).toBe(
            fee.toString(),
        )
        expect([...feeStore.values()][0]?.status).toBe('upgrade_confirmed')
        expect(gasFailures).toBe(1)
        expect(gasSpent).toBeGreaterThan(spentAfterFailure)
        const spentAfterRetry = gasSpent

        const again = await handleSendPreparedCalls(params, ctx)
        expect(again.id).toBe(retried.id)
        expect(captures.filter((body) => body.type === 'execute-intent')).toHaveLength(2)
        expect(gasSpent).toBe(spentAfterRetry)
    })

    it('sends only the upgrade when authorizationState is already true and the fee row is missing', async () => {
        rpc.authUsed = true
        gasHeld = PAID_UPGRADE_GAS_HOLD
        const { params } = await signedParams({ callData: '0xcf' })
        await handleSendPreparedCalls(params, createCtx())
        expect(captures.filter((body) => body.type === 'pull-paid-upgrade-fee')).toHaveLength(0)
        expect(captures.filter((body) => body.type === 'execute-intent')).toHaveLength(1)
        expect(captures).toHaveLength(1)
        const collected = feeLog.find((row) => row.status === 'fee_collected')
        expect(collected).toMatchObject({ status: 'fee_collected' })
        expect(collected?.pullTx).toBeUndefined()
        expect([...feeStore.values()][0]?.pullTx).toBeUndefined()
        const releases = gasLog.filter((entry) => entry.action === 'release-gas')
        expect(releases).toHaveLength(1)
        expect(releases[0]?.gas).toBe(PAID_UPGRADE_GAS_HOLD.toString())
        expect(gasHeld).toBe(0n)
    })

    it('retries a stuck delegation without a second authorization', async () => {
        rpc.upgradeRevertRemaining = 1
        const { params } = await signedParams({ callData: '0xee' })
        const ctx = createCtx()
        await expect(handleSendPreparedCalls(params, ctx)).rejects.toMatchObject({
            message: 'Paid upgrade was not included; retry will not charge the fee again',
        })
        rpc.code = eip7702DelegationCode(ACCOUNT_PROXY)
        rpc.nonce = '0x1'
        await handleSendPreparedCalls(params, ctx)
        const upgrades = captures.filter((body) => body.type === 'execute-intent')
        expect(upgrades).toHaveLength(2)
        expect(upgrades[0]?.authorization).toBeTruthy()
        expect(upgrades[1]?.authorization).toBeUndefined()
        expect(captures.filter((body) => body.type === 'pull-paid-upgrade-fee')).toHaveLength(1)
    })

    it('charges the pull against the same rate buckets and gas budget', async () => {
        const { params } = await signedParams()
        await handleSendPreparedCalls(params, createCtx('203.0.113.50'))
        expect(rateBodies.some((body) => body.action === 'reserve' && body.ip === '203.0.113.50')).toBe(
            true,
        )
        const reserves = gasLog.filter((entry) => entry.action === 'reserve-gas')
        const settles = gasLog.filter((entry) => entry.action === 'settle-gas')
        expect(reserves).toHaveLength(2)
        expect(settles).toHaveLength(2)
        expect(settles[0]?.failure).toBe(false)
        expect(BigInt(String(settles[0]?.gas))).toBe(21_000n)
        expect(gasHeld).toBe(0n)
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
