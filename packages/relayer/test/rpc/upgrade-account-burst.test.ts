/**
 * Parallel upgrades from one account must not broadcast more than the
 * identity cap. On cf99af2 every request peeks a shared counter, all of
 * them pass, and the later commit is dropped when it loses the race.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import { hashAuthorization } from 'viem/utils'

import { formerProd8453Env } from '../former-prod-env'
import { authMiddleware } from '../../src/auth/middleware'
import type { AuthProvider } from '../../src/auth/types'
import { dispatch } from '../../src/rpc/dispatcher'
import { createMethods } from '../../src/rpc/methods'
import type { Env } from '../../src/types/env'
import {
    consumeRateLimit,
    peekRateLimit,
    upgradeRateBuckets,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'

const CHAIN_ID = 8453
const ACCOUNT_PROXY = '0x3Be52867f8Dca2911f81076B37921c334dE29551' as Address
const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const BURST = 20
const NOW = 1_700_000_100

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

function createBurstGate(burst: number) {
    let rateCalls = 0
    const waiters: Array<() => void> = []
    return {
        note() {
            rateCalls += 1
            if (rateCalls < burst) return
            const pending = waiters.splice(0)
            for (const wake of pending) wake()
        },
        wait(): Promise<void> {
            if (rateCalls >= burst) return Promise.resolve()
            return new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('burst gate timed out')), 4_000)
                waiters.push(() => {
                    clearTimeout(timer)
                    resolve()
                })
            })
        },
    }
}

function createEnv(
    capture: unknown[],
    store: Map<string, number>,
    gate: ReturnType<typeof createBurstGate>,
): Env {
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bodyText = typeof init?.body === 'string' ? init.body : ''
        let parsed: { type?: string } & RateBody = {}
        if (bodyText) {
            try {
                parsed = JSON.parse(bodyText) as { type?: string } & RateBody
            } catch {
                parsed = {}
            }
        }

        if (parsed.type === 'create-account') {
            await gate.wait()
            capture.push(parsed)
            return {
                ok: false,
                json: async () => ({ error: 'execution reverted' }),
            } as unknown as Response
        }

        const buckets = upgradeRateBuckets({
            kind: parsed.kind === 'prepare' ? 'prepare' : 'upgrade',
            chainId: typeof parsed.chainId === 'number' ? parsed.chainId : CHAIN_ID,
            account: parsed.account ?? 'unknown',
            ip: parsed.ip ?? 'unknown',
            identity: parsed.identity,
        })
        gate.note()

        if (parsed.action === 'peek') {
            return {
                ok: true,
                json: async () => ({ allowed: peekRateLimit(store, buckets, NOW).allowed }),
            } as unknown as Response
        }

        if (parsed.action === 'release') {
            const at = typeof parsed.reservedAt === 'number' ? parsed.reservedAt : NOW
            for (const bucket of buckets) {
                const secondId = `${bucket.key}#${at}`
                const next = (store.get(secondId) ?? 0) - 1
                if (next <= 0) store.delete(secondId)
                else store.set(secondId, next)
            }
            return {
                ok: true,
                json: async () => ({ allowed: true }),
            } as unknown as Response
        }

        const decision = consumeRateLimit(store, buckets, NOW)
        return {
            ok: true,
            json: async () => ({ allowed: decision.allowed, reservedAt: NOW }),
        } as unknown as Response
    }

    return {
        SIGNER: {} as Env['SIGNER'],
        SIGNER_POOL: {
            idFromName: () => 'pool-id',
            get: () => ({ fetch }),
        } as unknown as Env['SIGNER_POOL'],
        INTENT_NONCE_MANAGER: {} as Env['INTENT_NONCE_MANAGER'],
        MONITOR_QUEUE: {} as Env['MONITOR_QUEUE'],
        RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
        CHAIN_IDS: String(CHAIN_ID),
        RPC_URL: 'http://127.0.0.1:18545',
        RPC_8453: 'http://127.0.0.1:18545',
        CONTEXT: 'prod',
        ...formerProd8453Env,
        AUTH_PROTECTED_METHODS: 'wallet_sendPreparedCalls',
        ERC8128_ENABLED: 'false',
        PRIVY_ENABLED: 'false',
    } as Env
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

describe('upgrade quota reservation', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', async () => {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('does not broadcast more than the identity cap when upgrades overlap', async () => {
        const owner = privateKeyToAccount(OWNER_KEY)
        const auth = await owner.sign({
            hash: hashAuthorization({
                contractAddress: ACCOUNT_PROXY,
                chainId: CHAIN_ID,
                nonce: 0,
            }),
        })
        const capture: unknown[] = []
        const store = new Map<string, number>()
        const env = createEnv(capture, store, createBurstGate(BURST))
        const app = createApp([providerFor(owner.address)])
        const body = {
            jsonrpc: '2.0' as const,
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
                            nonce: 0,
                        },
                        preCall: {
                            eoa: owner.address,
                            executionData: '0x',
                            nonce: '0',
                            signature: '0x',
                            chainId: '0x2105',
                        },
                    },
                    signatures: { auth, exec: '0x' },
                },
            ],
        }

        const results = await Promise.all(
            Array.from({ length: BURST }, async () => {
                const response = await app.request(
                    'http://localhost/',
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    },
                    env,
                )
                const json = (await response.json()) as { error?: { code?: number } }
                return json
            }),
        )

        const identityLimit = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: CHAIN_ID,
            account: owner.address,
            ip: 'unknown',
            identity: owner.address,
        })[0].limit
        const rateLimited = results.filter((result) => result.error?.code === -32014)

        expect(capture.length).toBe(identityLimit)
        expect(rateLimited).toHaveLength(BURST - identityLimit)
    })
})
