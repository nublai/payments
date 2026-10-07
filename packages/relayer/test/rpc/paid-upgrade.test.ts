/**
 * User-paid first EIP-7702 upgrade through wallet_sendPreparedCalls.
 * These cases refuse on the paid path. A quote with no accountUpgrade still
 * takes the existing execute-intent path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hashAuthorization } from 'viem/utils'

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
} from '../../src/rpc/errors'
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
    PAID_UPGRADE_ADDRESS_LIMIT,
    paidUpgradeRateBuckets,
} from '../../src/rpc/methods/shared/paid-upgrade'
import {
    consumeRateLimit,
    peekRateLimit,
    releaseRateLimit,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'

const CHAIN_ID = 8453
const SECRET = 'paid-upgrade-test-secret'
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
}

function word(value: bigint): Hex {
    return `0x${value.toString(16).padStart(64, '0')}` as Hex
}

function jsonResponse(body: unknown, ok = true): Response {
    return {
        ok,
        json: async () => body,
    } as Response
}

let captures: unknown[] = []
const rateStore = new Map<string, number>()

function poolFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url.includes('upgrade-rate-limit')) {
        const now = Math.floor(Date.now() / 1000)
        const buckets = paidUpgradeRateBuckets({
            chainId: typeof body.chainId === 'number' ? body.chainId : CHAIN_ID,
            account: typeof body.account === 'string' ? body.account : 'unknown',
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
        env: {
            RPC_URL: 'http://rpc.test/8453',
            RPC_8453: 'http://rpc.test/8453',
            CHAIN_IDS: String(CHAIN_ID),
            CONTEXT: 'local',
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
    txGas?: number
    maxFeePerGas?: number
    encodedPreCalls?: Hex[]
    mutateAfterSign?: (quote: Quote) => void
    echo?: Partial<PaidUpgradeQuote>
}): Promise<{ params: unknown; eoa: Address; upgrade: PaidUpgradeQuote }> {
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
            paymentToken: options?.paymentToken ?? USDC,
            paymentMaxAmount: options?.paymentMaxAmount ?? '1000000',
        },
        orchestrator: ORCHESTRATOR,
        extraPayment: '0x0',
        ethPrice: '0x0',
        paymentTokenDecimals: 6,
        txGas: options?.txGas ?? 100_000,
        nativeFeeEstimate: {
            maxFeePerGas: options?.maxFeePerGas ?? 1_000_000_000,
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
    return {
        eoa,
        upgrade,
        params: {
            context: { quote: signed },
            signature: `0x${'ab'.repeat(65)}`,
            ...(options?.echo ? { accountUpgrade: options.echo } : {}),
        },
    }
}

beforeEach(() => {
    captures = []
    rateStore.clear()
    rpc.code = '0x'
    rpc.nonce = '0x0'
    rpc.balance = 20_000_000n
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
        const results = batch.map((call: { id?: number; method?: string }) => {
            let result: string = '0x'
            if (call.method === 'eth_getCode') result = rpc.code
            else if (call.method === 'eth_getTransactionCount') result = rpc.nonce
            else if (call.method === 'eth_call') result = word(rpc.balance)
            else if (call.method === 'eth_chainId') result = '0x2105'
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
        const { params } = await signedParams()
        const result = await handleSendPreparedCalls(params, createCtx())
        expect(result.id).toEqual(expect.any(String))
        expect(captures).toHaveLength(1)
        const tx = captures[0] as {
            type: string
            authorization: { address: string; chainId: number; nonce: number; r: Hex; s: Hex }
        }
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
