/**
 * Follow-up regressions for the authenticated upgrade gas drain.
 *
 * On 612d64c a self-signed EIP-7702 authorization was enough: the relayer
 * broadcast whatever delegation the caller picked, including a stale nonce
 * and an arbitrary preCall, and it counted the attempt against the shared
 * upgrade budget before estimate or broadcast.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { encodeAbiParameters, type Address, type Hex } from 'viem'
import { hashAuthorization } from 'viem/utils'

import { installFormerProd8453 } from '../former-prod-env'
import { authMiddleware } from '../../src/auth/middleware'
import type { AuthProvider } from '../../src/auth/types'
import { dispatch } from '../../src/rpc/dispatcher'
import { createMethods } from '../../src/rpc/methods'
import type { Env } from '../../src/types/env'
import { testEnv } from '../helpers/env'
import { parseJson } from '../helpers/rpc'
import { jsonStub, signerPoolWithFetch } from '../helpers/stubs'
import { getChainConfig } from '../../src/config'
import {
    buildKeyInitializationData,
    getSignedCallDomain,
    SIGNED_CALL_TYPES,
    UPGRADE_PRECALL_NONCE,
} from '../../src/rpc/methods/shared/account-helpers'
import {
    consumeRateLimit,
    peekRateLimit,
    releaseRateLimit,
    upgradeRateBuckets,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'

const CHAIN_ID = 8453

const ACCOUNT_PROXY = '0x3Be52867f8Dca2911f81076B37921c334dE29551'

const BOMB_DELEGATION = '0x000000000000000000000000000000000000dEaD'

const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const OTHER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e141207b4c24b44a4361'

interface RateBody {
    action?: string
    kind?: 'prepare' | 'upgrade'
    chainId?: number
    account?: string
    ip?: string
    identity?: string
    reservedAt?: number
}

function providerFor(userId: string): AuthProvider {
    return {
        name: 'test',
        enabled: () => true,
        verify: async () => ({ ok: true, userId }),
    }
}

function createEnv(capture: unknown[], store: Map<string, number>): Env {
    const now = 1_700_000_100

    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bodyText = typeof init?.body === 'string' ? init.body : ''
        let parsed: { type?: string } & RateBody = {}

        if (bodyText) {
            try {
                parsed = parseJson<{ type?: string } & RateBody>(bodyText)
            } catch {
                parsed = {}
            }
        }

        if (parsed.type === 'create-account') {
            capture.push(parsed)

            return jsonStub({ error: 'execution reverted', broadcastAttempted: false }, false)
        }

        const buckets = upgradeRateBuckets({
            kind: parsed.kind === 'prepare' ? 'prepare' : 'upgrade',
            chainId: typeof parsed.chainId === 'number' ? parsed.chainId : CHAIN_ID,
            account: parsed.account ?? 'unknown',
            ip: parsed.ip ?? 'unknown',
            identity: parsed.identity,
        })

        if (parsed.action === 'release') {
            releaseRateLimit(
                store,
                buckets,
                typeof parsed.reservedAt === 'number' ? parsed.reservedAt : now,
            )

            return jsonStub({ allowed: true })
        }

        const allowed =
            parsed.action === 'peek'
                ? peekRateLimit(store, buckets, now).allowed
                : consumeRateLimit(store, buckets, now).allowed

        return jsonStub({ allowed, reservedAt: now })
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

function createApp(providers: AuthProvider[]) {
    const app = new Hono<{ Bindings: Env }>()
    app.use('*', authMiddleware({ providers }))
    app.post('/', async (c) => {
        const body = await c.req.json()

        const response = await dispatch(body, createMethods(c.env), {
            env: c.env,
            request: c.req.raw,
        })

        return c.json(response)
    })

    return app
}

function upgradeBody(args: {
    account: Address
    auth: Hex
    delegation: Address
    nonce?: number
    executionData?: Hex
    preCallNonce?: string
    exec?: Hex
}) {
    return {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'wallet_upgradeAccount',
        params: [
            {
                context: {
                    address: args.account,
                    chainId: '0x2105',
                    authorization: {
                        contractAddress: args.delegation,
                        chainId: CHAIN_ID,
                        nonce: args.nonce ?? 0,
                    },
                    preCall: {
                        eoa: args.account,
                        executionData: args.executionData ?? '0x',
                        nonce: args.preCallNonce ?? '0',
                        signature: '0x',
                        chainId: '0x2105',
                    },
                },
                signatures: {
                    auth: args.auth,
                    exec: args.exec ?? '0x',
                },
            },
        ],
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

async function post(env: Env, body: ReturnType<typeof upgradeBody>, userId: string) {
    const response = await createApp([providerFor(userId)]).request(
        'http://localhost/',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        env,
    )

    const text = await response.text()

    return { json: parseJson<{ error?: { code?: number; message?: string } }>(text), text }
}

let restoreDeployment: () => void

beforeAll(() => {
    restoreDeployment = installFormerProd8453()
})

afterAll(() => restoreDeployment())

describe('C1 upgrade broadcast guards', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = typeof init?.body === 'string' ? init.body : ''
            const result = body.includes('eth_getTransactionCount') ? '0x0' : '0x'

            return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('does not broadcast an attacker-chosen delegation', async () => {
        const owner = privateKeyToAccount(OWNER_KEY)
        const auth = await signAuth(OWNER_KEY, BOMB_DELEGATION, 0)
        const capture: unknown[] = []

        const result = await post(
            createEnv(capture, new Map()),
            upgradeBody({
                account: owner.address,
                auth,
                delegation: BOMB_DELEGATION,
            }),
            owner.address,
        )

        expect(capture).toEqual([])
        expect(result.json.error).toMatchObject({
            message: 'Delegation target is not the account proxy',
        })
    })

    it('does not broadcast a stale authorization nonce', async () => {
        const owner = privateKeyToAccount(OWNER_KEY)
        const auth = await signAuth(OWNER_KEY, ACCOUNT_PROXY, 7)
        const capture: unknown[] = []

        const result = await post(
            createEnv(capture, new Map()),
            upgradeBody({
                account: owner.address,
                auth,
                delegation: ACCOUNT_PROXY,
                nonce: 7,
            }),
            owner.address,
        )

        expect(capture).toEqual([])
        expect(result.json.error).toMatchObject({
            message: 'Authorization nonce does not match the account nonce',
        })
    })

    it('does not broadcast when the authenticated identity is not the account', async () => {
        const owner = privateKeyToAccount(OWNER_KEY)
        const other = privateKeyToAccount(OTHER_KEY)
        const auth = await signAuth(OWNER_KEY, ACCOUNT_PROXY, 0)
        const capture: unknown[] = []

        const result = await post(
            createEnv(capture, new Map()),
            upgradeBody({
                account: owner.address,
                auth,
                delegation: ACCOUNT_PROXY,
            }),
            other.address,
        )

        expect(capture).toEqual([])
        expect(result.json.error).toMatchObject({
            message: 'Authenticated identity is not bound to the account',
        })
    })

    it('rejects an arbitrary upgrade preCall before broadcast', async () => {
        const owner = privateKeyToAccount(OWNER_KEY)
        const auth = await signAuth(OWNER_KEY, ACCOUNT_PROXY, 0)
        const capture: unknown[] = []

        const result = await post(
            createEnv(capture, new Map()),
            upgradeBody({
                account: owner.address,
                auth,
                delegation: ACCOUNT_PROXY,
                executionData: '0x1234',
            }),
            owner.address,
        )

        expect(capture).toEqual([])
        expect(result.json.error).toMatchObject({
            message: 'Upgrade preCall is not allowed',
        })
    })

    it('still broadcasts a signed key-initialization preCall', async () => {
        const owner = privateKeyToAccount(OWNER_KEY)
        const capture: unknown[] = []
        const env = createEnv(capture, new Map())
        const config = getChainConfig(env, CHAIN_ID)
        const publicKey = encodeAbiParameters([{ type: 'address' }], [owner.address])

        const { calls, executionData } = buildKeyInitializationData(
            [
                {
                    expiry: '0',
                    type: 'secp256k1',
                    role: 'normal',
                    publicKey,
                    permissions: [
                        {
                            type: 'call',
                            to: owner.address,
                            selector: '0x12345678',
                        },
                    ],
                },
            ],
            owner.address,
        )

        const exec = await owner.signTypedData({
            domain: getSignedCallDomain(config.chainId, config.contracts.orchestrator),
            types: SIGNED_CALL_TYPES,
            primaryType: 'SignedCall',
            message: {
                multichain: false,
                eoa: owner.address,
                calls,
                nonce: UPGRADE_PRECALL_NONCE,
            },
        })

        const result = await post(
            env,
            upgradeBody({
                account: owner.address,
                auth: await signAuth(OWNER_KEY, ACCOUNT_PROXY, 0),
                delegation: ACCOUNT_PROXY,
                executionData,
                preCallNonce: UPGRADE_PRECALL_NONCE.toString(),
                exec,
            }),
            owner.address,
        )

        expect(capture).toHaveLength(1)
        expect(result.json.error?.message).toBe('Account upgrade failed')
        expect(result.json.error?.message).not.toBe('Upgrade preCall is not allowed')
    })

    it('does not consume an upgrade slot when broadcast fails', async () => {
        const owner = privateKeyToAccount(OWNER_KEY)
        const auth = await signAuth(OWNER_KEY, ACCOUNT_PROXY, 0)
        const capture: unknown[] = []
        const env = createEnv(capture, new Map())

        const body = upgradeBody({
            account: owner.address,
            auth,
            delegation: ACCOUNT_PROXY,
        })

        for (let attempt = 0; attempt < 6; attempt++) {
            const result = await post(env, body, owner.address)
            expect(result.json.error?.code).not.toBe(-32014)
        }

        expect(capture).toHaveLength(6)
    })

    it('failing upgrades do not lock out another account', async () => {
        const capture: unknown[] = []
        const env = createEnv(capture, new Map())

        for (let index = 0; index < 24; index++) {
            const key = generatePrivateKey()
            const account = privateKeyToAccount(key)
            const auth = await signAuth(key, ACCOUNT_PROXY, 0)

            for (let attempt = 0; attempt < 5; attempt++) {
                await post(
                    env,
                    upgradeBody({
                        account: account.address,
                        auth,
                        delegation: ACCOUNT_PROXY,
                    }),
                    account.address,
                )
            }
        }

        const freshKey = generatePrivateKey()
        const fresh = privateKeyToAccount(freshKey)
        const before = capture.length

        const result = await post(
            env,
            upgradeBody({
                account: fresh.address,
                auth: await signAuth(freshKey, ACCOUNT_PROXY, 0),
                delegation: ACCOUNT_PROXY,
            }),
            fresh.address,
        )

        expect(result.json.error?.code).not.toBe(-32014)
        expect(capture.length).toBe(before + 1)
    })
})
