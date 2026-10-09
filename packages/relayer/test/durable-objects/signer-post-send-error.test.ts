/**
 * A plain Error thrown after sendTransaction returns is not a pre-send
 * SignerDOError. Treating it as broadcastAttempted:false makes the pool
 * retry another signer and releases the upgrade slot.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { privateKeyToAccount } from 'viem/accounts'
import { hashAuthorization } from 'viem/utils'

import { installFormerProd8453 } from '../former-prod-env'
import { authMiddleware } from '../../src/auth/middleware'
import type {AuthProvider} from '../../src/auth/types'
import { SignerDO } from '../../src/durable-objects/signer.do'
import { SignerPoolDO } from '../../src/durable-objects/signer-pool.do'
import { dispatch } from '../../src/rpc/dispatcher'
import { createMethods } from '../../src/rpc/methods'
import type {Env} from '../../src/types/env'
import type {IndexedCapacityInfo, SendResult} from '../../src/types/pool'
import { testEnv } from '../helpers/env'
import { parseJson } from '../helpers/rpc'
import { jsonStub, signerNamespace, signerPoolWithFetch } from '../helpers/stubs'
import {
    consumeRateLimit,
    releaseRateLimit,
    upgradeRateBuckets,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'

const CHAIN_ID = 8453

const ACCOUNT_PROXY = '0x3Be52867f8Dca2911f81076B37921c334dE29551'

const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const NOW = 1_700_000_500

interface RateBody {
    action?: string
    kind?: 'prepare' | 'upgrade'
    chainId?: number
    account?: string
    ip?: string
    identity?: string
    reservedAt?: number
    type?: string
}

let restoreDeployment: () => void

beforeAll(() => {
    restoreDeployment = installFormerProd8453()
})

afterAll(() => restoreDeployment())

describe('post-send signer errors', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('keeps the slot when a plain error is thrown after the send', async () => {
        const signer: SignerDO = Object.create(SignerDO.prototype)
        signer.sendTransaction = async (): Promise<SendResult> => ({
            txHash: '0xabc',
            nonce: 1,
            signer: '0x0000000000000000000000000000000000000001',
            signerName: 'signer-8453-0',
        })

        const originalJson = Response.json

        function jsonAfterSend(data: Parameters<typeof Response.json>[0], init?: ResponseInit): Response {
            if (
                data !== null &&
                typeof data === 'object' &&
                'txHash' in data &&
                (init?.status === undefined || init.status < 400)
            ) {
                throw new Error('post-send bookkeeping failed')
            }

            return originalJson.call(Response, data, init)
        }

        Response.json = jsonAfterSend

        let signerBody: { error?: string; broadcastAttempted?: boolean }

        try {
            const response = await signer.fetch(
                new Request('http://do/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: 'tx-1', type: 'create-account' }) }),
            )

            signerBody = await response.json()
        } finally {
            Response.json = originalJson
        }

        const seen: string[] = []

        type PoolHarness = Pick<SignerPoolDO, 'sendTransaction'> & {
            env: Env
            ctx: { id: { name: string } }
            getAllCapacities: () => Promise<IndexedCapacityInfo[]>
        }

        const pool: PoolHarness = Object.create(SignerPoolDO.prototype)

        pool.env = testEnv({
            RELAYER_COUNT: '2',
            SIGNER: signerNamespace({
                idFromName: (name: string) => name,
                get: (name: string) => ({
                    fetch: async () => {
                        seen.push(String(name))

                        if (seen.length === 1) {
                            return Response.json(signerBody, { status: 500 })
                        }

                        return Response.json({
                            txHash: '0xdef',
                            nonce: 2,
                            signer: '0x0000000000000000000000000000000000000002',
                            signerName: 'signer-8453-1',
                        })
                    },
                }),
            }),
        })
        pool.ctx = { id: { name: 'pool-8453' } }
        pool.getAllCapacities = async () => [
            {
                index: 0,
                capacity: 10,
                pending: 0,
                address: '0x0000000000000000000000000000000000000001',
                error: false },
            {
                index: 1,
                capacity: 1,
                pending: 0,
                address: '0x0000000000000000000000000000000000000002',
                error: false },
        ]

        let poolBroadcastAttempted: boolean | undefined

        try {
            await pool.sendTransaction({
                id: 'tx-1',
                type: 'create-account',
                accountAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
                ownerAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
                authorization: {
                    address: ACCOUNT_PROXY,
                    chainId: CHAIN_ID,
                    nonce: 0,
                    r: '0x1',
                    s: '0x2',
                    yParity: 0 } })
            poolBroadcastAttempted = undefined
        } catch (error) {
            // SAFETY: SignerPoolDO attaches broadcastAttempted to the Error it throws after a send.
            poolBroadcastAttempted = (error as { broadcastAttempted?: boolean }).broadcastAttempted
        }

        vi.stubGlobal('fetch', async () => {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' } })
        })
        const owner = privateKeyToAccount(OWNER_KEY)

        const auth = await owner.sign({
            hash: hashAuthorization({
                contractAddress: ACCOUNT_PROXY,
                chainId: CHAIN_ID,
                nonce: 0 }) })

        const store = new Map<string, number>()
        let releases = 0

        const env = createUpgradeEnv(store, () => {
            releases += 1
        }, signerBody)

        const app = new Hono<{ Bindings: Env }>()

        const provider: AuthProvider = {
            name: 'test',
            enabled: () => true,
            verify: async () => ({ ok: true, userId: owner.address }) }

        app.use('*', authMiddleware({ providers: [provider] }))
        app.post('/', async (c) => {
            const body = await c.req.json()

            const response = await dispatch(body, createMethods(c.env), {
                env: c.env,
                request: c.req.raw })

            return c.json(response)
        })
        await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'wallet_upgradeAccount',
                    params: [
                        {
                            context: {
                                address: owner.address,
                                chainId: '0x2105',
                                authorization: {
                                    contractAddress: ACCOUNT_PROXY,
                                    chainId: CHAIN_ID,
                                    nonce: 0 },
                                preCall: {
                                    eoa: owner.address,
                                    executionData: '0x',
                                    nonce: '0',
                                    signature: '0x',
                                    chainId: '0x2105' } },
                            signatures: { auth, exec: '0x' } },
                    ] }) },
            env,
        )

        const identityKey = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: CHAIN_ID,
            account: owner.address,
            ip: 'unknown',
            identity: owner.address })[0].key

        expect({
            signerBroadcastAttempted: signerBody.broadcastAttempted ?? null,
            signersTried: seen,
            poolBroadcastAttempted: poolBroadcastAttempted ?? null,
            releases,
            identityHits: store.get(`${identityKey}#${NOW}`) ?? 0 }).toEqual({
            signerBroadcastAttempted: true,
            signersTried: ['signer-8453-0'],
            poolBroadcastAttempted: true,
            releases: 0,
            identityHits: 1 })
    })
})

function createUpgradeEnv(
    store: Map<string, number>,
    onRelease: () => void,
    signerBody: { error?: string; broadcastAttempted?: boolean },
): Env {
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bodyText = typeof init?.body === 'string' ? init.body : ''
        let parsed: RateBody = {}

        if (bodyText) {
            try {
                parsed = parseJson<RateBody>(bodyText)
            } catch {
                parsed = {}
            }
        }

        if (parsed.type === 'create-account') {
            return jsonStub(signerBody, false)
        }

        const buckets = upgradeRateBuckets({
            kind: parsed.kind === 'prepare' ? 'prepare' : 'upgrade',
            chainId: typeof parsed.chainId === 'number' ? parsed.chainId : CHAIN_ID,
            account: parsed.account ?? 'unknown',
            ip: parsed.ip ?? 'unknown',
            identity: parsed.identity })

        if (parsed.action === 'release') {
            onRelease()
            releaseRateLimit(
                store,
                buckets,
                typeof parsed.reservedAt === 'number' ? parsed.reservedAt : NOW,
            )

            return jsonStub({ allowed: true })
        }

        const allowed = consumeRateLimit(store, buckets, NOW).allowed

        return jsonStub({ allowed, reservedAt: NOW })
    }

    return testEnv({
        SIGNER_POOL: signerPoolWithFetch(fetch),
        CHAIN_IDS: String(CHAIN_ID),
        RPC_URL: 'http://127.0.0.1:18545',
        RPC_8453: 'http://127.0.0.1:18545',
        CONTEXT: 'prod',
        AUTH_PROTECTED_METHODS: 'wallet_sendPreparedCalls',
        ERC8128_ENABLED: 'false',
        PRIVY_ENABLED: 'false',
    })
}
