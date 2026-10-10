/**
 * C1 regression: wallet_upgradeAccount must not sign or broadcast without
 * authentication and a matching EIP-7702 authorization, and its errors must
 * not include the RPC URL or the signed raw transaction.
 *
 * Mirrors the local proof: a dummy 65-byte auth against a worker whose
 * AUTH_PROTECTED_METHODS list omits upgrade, with the signer pool standing in
 * for eth_sendRawTransaction.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hashAuthorization } from 'viem/utils'

import { installFormerProd8453 } from '../former-prod-env'
import { authMiddleware } from '../../src/auth/middleware'
import type { AuthProvider } from '../../src/auth/types'
import { dispatch } from '../../src/rpc/dispatcher'
import { createMethods } from '../../src/rpc/methods'
import type { Env } from '../../src/types/env'
import { testEnv } from '../helpers/env'
import { parseHex } from '../helpers/hex'
import { parseJson } from '../helpers/rpc'
import { jsonStub, signerPoolWithFetch } from '../helpers/stubs'

const RPC_URL = 'http://127.0.0.1:18545'

const RAW_TX = '0x04' + 'ab'.repeat(128) + 'cd'.repeat(32)

const LEAKY_POOL_ERROR = [
    'HTTP request failed.',
    '',
    `URL: ${RPC_URL}`,
    'Request body: {"method":"eth_sendRawTransaction","params":["' + RAW_TX + '"]}',
].join('\n')

const DUMMY_AUTH = parseHex(`0x${'11'.repeat(32)}${'22'.repeat(32)}1b`)

const VICTIM = '0x1111111111111111111111111111111111111111'

const DELEGATION = '0x2222222222222222222222222222222222222222'

const ACCOUNT_PROXY = '0x3Be52867f8Dca2911f81076B37921c334dE29551'

const CHAIN_ID = 8453

const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

interface BroadcastCapture {
    broadcasts: unknown[]
}

function createEnv(
    capture: BroadcastCapture,
    overrides: Partial<Env> = {},
    options: { upgradeAllowed?: boolean } = {},
): Env {
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bodyText = typeof init?.body === 'string' ? init.body : ''
        let parsed: { type?: string } | null = null

        if (bodyText) {
            try {
                parsed = parseJson<{ type?: string }>(bodyText)
            } catch {
                parsed = null
            }
        }

        if (parsed?.type === 'create-account') {
            capture.broadcasts.push(parsed)

            return jsonStub({ error: LEAKY_POOL_ERROR }, false)
        }

        return jsonStub({ allowed: options.upgradeAllowed !== false })
    }

    return testEnv({
        SIGNER_POOL: signerPoolWithFetch(fetch),
        CHAIN_IDS: String(CHAIN_ID),
        RPC_URL,
        RPC_8453: RPC_URL,
        CONTEXT: 'prod',
        AUTH_PROTECTED_METHODS: 'wallet_sendPreparedCalls',
        ERC8128_ENABLED: 'false',
        PRIVY_ENABLED: 'false',
        ...overrides,
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

const acceptingProvider: AuthProvider = {
    name: 'test',
    enabled: () => true,
    verify: async () => ({ ok: true, userId: VICTIM }),
}

function providerFor(userId: string): AuthProvider {
    return {
        name: 'test',
        enabled: () => true,
        verify: async () => ({ ok: true, userId }),
    }
}

function stubPendingNonce() {
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? init.body : ''
        const result = body.includes('eth_getTransactionCount') ? '0x0' : '0x'

        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    })
}

function upgradeBody(auth: Hex, account: Address, delegation: Address = DELEGATION) {
    return {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'wallet_upgradeAccount',
        params: [
            {
                context: {
                    address: account,
                    chainId: '0x2105',
                    authorization: {
                        contractAddress: delegation,
                        chainId: CHAIN_ID,
                        nonce: 0,
                    },
                    preCall: {
                        eoa: account,
                        executionData: '0x',
                        nonce: '0',
                        signature: '0x',
                        chainId: '0x2105',
                    },
                },
                signatures: {
                    auth,
                    exec: '0x',
                },
            },
        ],
    }
}

async function post(
    env: Env,
    body: {
        jsonrpc: '2.0'
        id: number
        method: string
        params: ReturnType<typeof upgradeBody>['params'] | Array<{
            address: Address
            delegation: Address
            chainId: string
            capabilities: { authorizeKeys: never[] }
        }>
    },
    providers: AuthProvider[],
): Promise<{ status: number; json: unknown; text: string }> {
    const response = await createApp(providers).request(
        'http://localhost/',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        env,
    )

    const text = await response.text()

    const json: unknown = JSON.parse(text)

    return { status: response.status, json, text }
}

function expectNoLeak(text: string) {
    expect(text).not.toContain(RPC_URL)
    expect(text).not.toContain(RAW_TX)
    expect(text).not.toContain('eth_sendRawTransaction')
}

let restoreDeployment: () => void

beforeAll(() => {
    restoreDeployment = installFormerProd8453()
})

afterAll(() => restoreDeployment())

describe('C1 wallet_upgradeAccount', () => {
    it('unauthenticated wallet_upgradeAccount does not broadcast and does not leak the RPC URL or raw transaction', async () => {
        const capture: BroadcastCapture = { broadcasts: [] }
        const result = await post(createEnv(capture), upgradeBody(DUMMY_AUTH, VICTIM), [])

        expect(result.status).toBe(200)
        expect(capture.broadcasts).toEqual([])
        expectNoLeak(result.text)
        expect(result.json).toMatchObject({
            jsonrpc: '2.0',
            id: 1,
            error: {
                code: -32001,
                message: 'Unauthorized',
            },
        })
    })

    it('wallet_upgradeAccount stays unauthorized when AUTH_PROTECTED_METHODS is none', async () => {
        const capture: BroadcastCapture = { broadcasts: [] }

        const result = await post(
            createEnv(capture, { AUTH_PROTECTED_METHODS: 'none' }),
            upgradeBody(DUMMY_AUTH, VICTIM),
            [],
        )

        expect(capture.broadcasts).toEqual([])
        expectNoLeak(result.text)
        expect(result.json).toMatchObject({
            error: { code: -32001, message: 'Unauthorized' },
        })
    })

    it('authenticated wallet_upgradeAccount with a bogus authorization does not broadcast', async () => {
        const capture: BroadcastCapture = { broadcasts: [] }

        const result = await post(createEnv(capture), upgradeBody(DUMMY_AUTH, VICTIM), [
            acceptingProvider,
        ])

        expect(result.status).toBe(200)
        expect(capture.broadcasts).toEqual([])
        expectNoLeak(result.text)
        expect(result.json).toMatchObject({
            error: {
                code: -32005,
                message: 'Invalid authorization signature',
            },
        })
    })

    it('wallet_upgradeAccount broadcast failure does not return the RPC URL or raw transaction', async () => {
        const owner = privateKeyToAccount(OWNER_KEY)

        const auth = await owner.sign({
            hash: hashAuthorization({
                contractAddress: ACCOUNT_PROXY,
                chainId: CHAIN_ID,
                nonce: 0,
            }),
        })

        const capture: BroadcastCapture = { broadcasts: [] }
        stubPendingNonce()
        let result: Awaited<ReturnType<typeof post>>

        try {
            result = await post(
                createEnv(capture),
                upgradeBody(auth, owner.address, ACCOUNT_PROXY),
                [providerFor(owner.address)],
            )
        } finally {
            vi.unstubAllGlobals()
        }

        expect(result.status).toBe(200)
        expect(capture.broadcasts).toHaveLength(1)
        expectNoLeak(result.text)
        expect(result.json).toMatchObject({
            error: {
                code: -32002,
                message: 'Account upgrade failed',
            },
        })
    })

    it('does not broadcast when the upgrade rate limit is exceeded', async () => {
        const owner = privateKeyToAccount(OWNER_KEY)

        const auth = await owner.sign({
            hash: hashAuthorization({
                contractAddress: ACCOUNT_PROXY,
                chainId: CHAIN_ID,
                nonce: 0,
            }),
        })

        const capture: BroadcastCapture = { broadcasts: [] }
        stubPendingNonce()
        let result: Awaited<ReturnType<typeof post>>

        try {
            result = await post(
                createEnv(capture, {}, { upgradeAllowed: false }),
                upgradeBody(auth, owner.address, ACCOUNT_PROXY),
                [providerFor(owner.address)],
            )
        } finally {
            vi.unstubAllGlobals()
        }

        expect(capture.broadcasts).toEqual([])
        expectNoLeak(result.text)
        expect(result.json).toMatchObject({
            error: {
                code: -32014,
                message: 'Upgrade rate limit exceeded',
            },
        })
    })

    it('unauthenticated wallet_prepareUpgradeAccount is rejected before preparing an upgrade', async () => {
        const capture: BroadcastCapture = { broadcasts: [] }

        const result = await post(
            createEnv(capture),
            {
                jsonrpc: '2.0',
                id: 4,
                method: 'wallet_prepareUpgradeAccount',
                params: [
                    {
                        address: VICTIM,
                        delegation: DELEGATION,
                        chainId: '0x2105',
                        capabilities: { authorizeKeys: [] },
                    },
                ],
            },
            [],
        )

        expect(capture.broadcasts).toEqual([])
        expectNoLeak(result.text)
        expect(result.json).toMatchObject({
            jsonrpc: '2.0',
            id: 4,
            error: {
                code: -32001,
                message: 'Unauthorized',
            },
        })
    })
})
