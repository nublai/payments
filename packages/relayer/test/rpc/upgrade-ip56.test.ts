/**
 * A /56 of IPv6 is one network. /64 buckets alone let twenty of them
 * inside that /56 spend the whole per-chain upgrade budget.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { mnemonicToAccount } from 'viem/accounts'
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
    releaseRateLimit,
    upgradeClientIp,
    upgradeRateBuckets,
} from '../../src/rpc/methods/shared/upgrade-rate-limit'

const CHAIN_ID = 8453
const ACCOUNT_PROXY = '0x3Be52867f8Dca2911f81076B37921c334dE29551' as Address
const NOW = 1_700_000_400
const MNEMONIC = 'test test test test test test test test test test test junk'

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

function headerIp(value: string): string {
    return upgradeClientIp(
        new Request('https://relayer.example/', { headers: { 'cf-connecting-ip': value } }),
    )
}

function slash56Key(kind: 'prepare' | 'upgrade', ip: string): string | undefined {
    return upgradeRateBuckets({
        kind,
        chainId: CHAIN_ID,
        account: '0x1111111111111111111111111111111111111111',
        ip,
    }).find((bucket) => bucket.key.includes(':ip56:'))?.key
}

/** Host inside 2001:db8:ab00::/56, one distinct /64 per index, three text forms. */
function hostInSlash56(index: number): string {
    const hextet = index.toString(16).padStart(4, '0')
    const variant = index % 3
    if (variant === 0) return `2001:db8:ab00:${hextet}::1`
    if (variant === 1) return `2001:DB8:AB00:${hextet}::1`
    return `2001:0db8:ab00:${hextet}:0000:0000:0000:0001`
}

function accountAt(index: number) {
    return mnemonicToAccount(MNEMONIC, { addressIndex: index })
}

function providerForRequest(): AuthProvider {
    return {
        name: 'test',
        enabled: () => true,
        verify: async (request) => {
            const body = (await request.json()) as {
                params?: Array<{ context?: { address?: string } }>
            }
            const userId = body.params?.[0]?.context?.address
            return { ok: true, userId }
        },
    }
}

function createEnv(capture: unknown[], store: Map<string, number>): Env {
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bodyText = typeof init?.body === 'string' ? init.body : ''
        let parsed: RateBody = {}
        if (bodyText) {
            try {
                parsed = JSON.parse(bodyText) as RateBody
            } catch {
                parsed = {}
            }
        }

        if (parsed.type === 'create-account') {
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
        if (parsed.action === 'release') {
            releaseRateLimit(
                store,
                buckets,
                typeof parsed.reservedAt === 'number' ? parsed.reservedAt : NOW,
            )
            return {
                ok: true,
                json: async () => ({ allowed: true }),
            } as unknown as Response
        }
        const allowed = consumeRateLimit(store, buckets, NOW).allowed
        return {
            ok: true,
            json: async () => ({ allowed, reservedAt: NOW }),
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
        RELAYER_MNEMONIC: MNEMONIC,
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

function createApp() {
    const app = new Hono<{ Bindings: Env }>()
    app.use('*', authMiddleware({ providers: [providerForRequest()] }))
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

describe('upgrade IPv6 /56 buckets', () => {
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

    it('stops a /56 at the IP ceiling and still serves a different /56', async () => {
        const capture: unknown[] = []
        const store = new Map<string, number>()
        const env = createEnv(capture, store)
        const app = createApp()
        const perIdentity = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: CHAIN_ID,
            account: '0xabc',
            ip: '203.0.113.5',
        })[0].limit

        for (let prefix = 0; prefix < 20; prefix++) {
            const account = accountAt(prefix)
            const auth = await account.sign({
                hash: hashAuthorization({
                    contractAddress: ACCOUNT_PROXY,
                    chainId: CHAIN_ID,
                    nonce: 0,
                }),
            })
            for (let hit = 0; hit < perIdentity; hit++) {
                await app.request(
                    'http://localhost/',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'cf-connecting-ip': hostInSlash56(prefix),
                        },
                        body: JSON.stringify(upgradeBody(account.address, auth)),
                    },
                    env,
                )
            }
        }

        const overflowAccount = accountAt(20)
        const overflowAuth = await overflowAccount.sign({
            hash: hashAuthorization({
                contractAddress: ACCOUNT_PROXY,
                chainId: CHAIN_ID,
                nonce: 0,
            }),
        })
        const beforeOverflow = capture.length
        const overflowResponse = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'cf-connecting-ip': '2001:0DB8:ab00:0014:0000:0000:0000:0001',
                },
                body: JSON.stringify(upgradeBody(overflowAccount.address, overflowAuth)),
            },
            env,
        )
        const overflow = (await overflowResponse.json()) as { error?: { code?: number } }

        const otherAccount = accountAt(21)
        const otherAuth = await otherAccount.sign({
            hash: hashAuthorization({
                contractAddress: ACCOUNT_PROXY,
                chainId: CHAIN_ID,
                nonce: 0,
            }),
        })
        const otherResponse = await app.request(
            'http://localhost/',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'cf-connecting-ip': '2001:DB8:AB00:0100::1',
                },
                body: JSON.stringify(upgradeBody(otherAccount.address, otherAuth)),
            },
            env,
        )
        const other = (await otherResponse.json()) as { error?: { code?: number } }

        expect({
            broadcastsBeforeOverflow: beforeOverflow,
            overflowCode: overflow.error?.code ?? null,
            broadcastsAfterOverflow: capture.length - beforeOverflow,
            otherCode: other.error?.code ?? null,
            otherBroadcast: capture.length - beforeOverflow > 0,
        }).toEqual({
            broadcastsBeforeOverflow: 100,
            overflowCode: -32014,
            broadcastsAfterOverflow: 1,
            otherCode: -32002,
            otherBroadcast: true,
        })
    })

    it('counts every text form of one /56 in the same bucket', () => {
        const forms = [
            '2001:db8:ab00:13::1',
            '2001:DB8:AB00:0013::1',
            '2001:0db8:ab00:0013:0000:0000:0000:0001',
            '2001:db8:ab00:7f:0:0:0:abcd',
            '2001:0DB8:ab00:007f:0000:0000:0000:ABCD',
        ]
        const keys = forms.map((form) => slash56Key('upgrade', headerIp(form)))
        expect(keys).toEqual([
            'upgrade:ip56:8453:2001:db8:ab00::',
            'upgrade:ip56:8453:2001:db8:ab00::',
            'upgrade:ip56:8453:2001:db8:ab00::',
            'upgrade:ip56:8453:2001:db8:ab00::',
            'upgrade:ip56:8453:2001:db8:ab00::',
        ])

        const slash64 = forms.map((form) => {
            return upgradeRateBuckets({
                kind: 'upgrade',
                chainId: CHAIN_ID,
                account: '0xabc',
                ip: headerIp(form),
            })[1].key
        })
        expect(slash64[0]).toBe(slash64[1])
        expect(slash64[0]).not.toBe(slash64[3])

        const limit = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: CHAIN_ID,
            account: '0xabc',
            ip: headerIp(forms[0]),
        }).find((bucket) => bucket.key.includes(':ip56:'))!.limit
        const store = new Map<string, number>()
        for (let hit = 0; hit < limit; hit++) {
            const buckets = upgradeRateBuckets({
                kind: 'upgrade',
                chainId: CHAIN_ID,
                account: `0x${(hit + 1).toString(16).padStart(40, '0')}`,
                ip: headerIp(forms[hit % forms.length]),
            })
            expect(consumeRateLimit(store, buckets, NOW).allowed).toBe(true)
        }
        const overflow = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: CHAIN_ID,
            account: '0x00000000000000000000000000000000000000aa',
            ip: headerIp('2001:0db8:ab00:00aa:0000:0000:0000:0001'),
        })
        expect(consumeRateLimit(store, overflow, NOW).allowed).toBe(false)
        expect(slash56Key('upgrade', headerIp('2001:0db8:ab00:00aa::1'))).toBe(keys[0])

        const prepare = upgradeRateBuckets({
            kind: 'prepare',
            chainId: CHAIN_ID,
            account: '0xabc',
            ip: headerIp(forms[0]),
        }).find((bucket) => bucket.key.includes(':ip56:'))
        expect(prepare?.limit).toBe(400)
        expect(prepare?.key).toBe('prepare:ip56:8453:2001:db8:ab00::')

        const v4 = upgradeRateBuckets({
            kind: 'upgrade',
            chainId: CHAIN_ID,
            account: '0xabc',
            ip: headerIp('::ffff:203.0.113.9'),
        })
        expect(v4.some((bucket) => bucket.key.includes(':ip56:'))).toBe(false)
        expect(v4).toHaveLength(3)
    })
})

function upgradeBody(account: Address, auth: Hex) {
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
                        contractAddress: ACCOUNT_PROXY,
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
                signatures: { auth, exec: '0x' },
            },
        ],
    }
}
