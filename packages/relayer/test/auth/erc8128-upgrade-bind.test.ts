/**
 * `tw account create` / `tw account delegate` sign wallet_prepareUpgradeAccount
 * and wallet_upgradeAccount with ERC-8128 using the fresh account's own root
 * key, and send no bearer token. Outside local, that key is not on
 * ERC8128_ALLOWED_SIGNERS. The upgrade methods bind their account the same
 * way prepare/send do, so the account's own key is accepted and any other
 * address is still refused.
 */

import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { bytesToHex, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { signRequest } from '@slicekit/erc8128'

import { authMiddleware } from '../../src/auth/middleware'
import { identityAuthProviders } from '../../src/auth/identity-registry'
import { createErc8128Provider } from '../../src/auth/providers/erc8128'
import type { Env } from '../../src/types/env'

const { readContract } = vi.hoisted(() => ({
    readContract: vi.fn(async () => {
        throw new Error('no key')
    }),
}))

vi.mock('../../src/lib/multi-chain-client', async () => {
    const actual = await vi.importActual<typeof import('../../src/lib/multi-chain-client')>(
        '../../src/lib/multi-chain-client',
    )
    return {
        ...actual,
        getChainClient: () => ({
            getCode: async () => undefined,
            readContract,
            verifyMessage: async () => false,
        }),
    }
})

const CHAIN_ID = 8453
const ACCOUNT_PROXY = '0x3Be52867f8Dca2911f81076B37921c334dE29551'
const METHODS = ['wallet_prepareUpgradeAccount', 'wallet_upgradeAccount'] as const
type UpgradeMethod = (typeof METHODS)[number]

/** Stage/prod shape: Privy on, ERC-8128 on, signer not allowlisted. */
function prodEnv(overrides: Partial<Env> = {}): Env {
    return {
        CHAIN_IDS: String(CHAIN_ID),
        RPC_8453: 'http://127.0.0.1:1',
        CONTEXT: 'prod',
        NODE_ENV: 'production',
        PRIVY_ENABLED: 'true',
        PRIVY_APP_ID: 'app-id',
        PRIVY_APP_SECRET: 'app-secret',
        ERC8128_ENABLED: 'true',
        HTTP_AUTH_NONCE_MANAGER: {
            idFromName: () => 'nonce',
            get: () => ({ consumeNonce: async () => true }),
        },
        ...overrides,
    } as unknown as Env
}

function upgradeParams(method: UpgradeMethod, address: Address, chainId: unknown) {
    const chain = chainId === undefined ? {} : { chainId }
    return method === 'wallet_prepareUpgradeAccount'
        ? [{ address, delegation: ACCOUNT_PROXY, ...chain }]
        : [{ context: { address, ...chain }, signatures: {} }]
}

async function cliRequest(
    key: Hex,
    method: UpgradeMethod,
    target?: { address?: Address; chainId?: unknown },
): Promise<Request> {
    const account = privateKeyToAccount(key)
    const chainId = target && 'chainId' in target ? target.chainId : `0x${CHAIN_ID.toString(16)}`
    const params = upgradeParams(method, target?.address ?? account.address, chainId)
    const created = Math.floor(Date.now() / 1000) - 1
    return signRequest(
        new Request('https://relayer.example.com/', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
        {
            chainId: CHAIN_ID,
            address: account.address,
            signMessage: (message) => account.signMessage({ message: { raw: bytesToHex(message) } }),
        },
        {
            label: 'eth',
            binding: 'request-bound',
            replay: 'non-replayable',
            created,
            expires: created + 60,
            nonce: crypto.randomUUID(),
            contentDigest: 'auto',
        },
    )
}

async function erc8128Verify(request: Request, env: Env) {
    return createErc8128Provider().verify(request, {
        env,
        nowSeconds: Math.floor(Date.now() / 1000),
    })
}

/** The worker's middleware and provider order from src/index.ts. */
async function throughWorker(request: Request, env: Env) {
    let reached = false
    const app = new Hono<{ Bindings: Env }>()
    app.use('*', authMiddleware({ providers: [...identityAuthProviders(), createErc8128Provider()] }))
    app.post('/', (c) => {
        reached = true
        return c.json({ jsonrpc: '2.0', id: 1, result: 'handler reached' })
    })
    const response = await app.fetch(request, env)
    return { reached, body: (await response.json()) as Record<string, unknown> }
}

const STRANGER = privateKeyToAccount(generatePrivateKey()).address

describe('ERC-8128 binds the account on sponsored upgrade methods', () => {
    for (const context of ['prod', 'stage']) {
        for (const allowlist of [undefined, '', STRANGER]) {
            for (const method of METHODS) {
                it(`${context} allowlist=${JSON.stringify(allowlist)}: a fresh account's own key may call ${method}`, async () => {
                    const key = generatePrivateKey()
                    const address = privateKeyToAccount(key).address
                    const env = prodEnv({ CONTEXT: context, ERC8128_ALLOWED_SIGNERS: allowlist })

                    expect(await erc8128Verify(await cliRequest(key, method), env)).toEqual({
                        ok: true,
                        userId: address.toLowerCase(),
                    })
                    const worker = await throughWorker(await cliRequest(key, method), env)
                    expect(worker.body).toEqual({ jsonrpc: '2.0', id: 1, result: 'handler reached' })
                    expect(worker.reached).toBe(true)
                })
            }
        }
    }

    it('accepts the own key when AUTH_PROTECTED_METHODS lists the upgrade methods', async () => {
        const env = prodEnv({ AUTH_PROTECTED_METHODS: `wallet_sendPreparedCalls,${METHODS.join(',')}` })
        for (const method of METHODS) {
            const key = generatePrivateKey()
            const result = await erc8128Verify(await cliRequest(key, method), env)
            expect(result).toEqual({ ok: true, userId: privateKeyToAccount(key).address.toLowerCase() })
        }
    })

    it('refuses the same fresh key for a different address, on any chain id', async () => {
        const other = privateKeyToAccount(generatePrivateKey()).address
        const cases: Array<{ label: string; chainId: unknown }> = [
            { label: 'same chain', chainId: `0x${CHAIN_ID.toString(16)}` },
            { label: 'numeric chain', chainId: CHAIN_ID },
            { label: 'mismatched chain', chainId: '0x14a34' },
            { label: 'no chain id', chainId: undefined },
        ]
        for (const method of METHODS) {
            for (const { label, chainId } of cases) {
                readContract.mockClear()
                const key = generatePrivateKey()
                const env = prodEnv()
                const request = () => cliRequest(key, method, { address: other, chainId })

                expect(await erc8128Verify(await request(), env), `${method} ${label}`).toMatchObject({
                    ok: false,
                    code: 'SIGNER_NOT_ALLOWED',
                })
                const worker = await throughWorker(await request(), env)
                expect(worker.reached, `${method} ${label}`).toBe(false)
                expect(worker.body, `${method} ${label}`).toMatchObject({
                    error: { code: -32001, message: 'Unauthorized' },
                })
                const off = await throughWorker(await request(), prodEnv({ PRIVY_ENABLED: 'false' }))
                expect(off.reached, `${method} ${label}`).toBe(false)
                expect(off.body, `${method} ${label}`).toMatchObject({
                    error: { code: -32001, message: 'Unauthorized', data: { auth_code: 'SIGNER_NOT_ALLOWED' } },
                })
            }
        }
    })

    it('still lets an allowlisted signer, or local with no allowlist, through', async () => {
        for (const method of METHODS) {
            const key = generatePrivateKey()
            const listed = prodEnv({ ERC8128_ALLOWED_SIGNERS: privateKeyToAccount(key).address })
            expect((await throughWorker(await cliRequest(key, method), listed)).reached).toBe(true)
            const local = prodEnv({ CONTEXT: 'local' })
            expect((await throughWorker(await cliRequest(generatePrivateKey(), method), local)).reached).toBe(true)
        }
    })
})
