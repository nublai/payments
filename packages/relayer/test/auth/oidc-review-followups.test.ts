import wranglerToml from '../../wrangler.toml?raw'
import { env } from 'cloudflare:test'
import { errors, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { getAddress, type Address } from 'viem'

import { authIdentityOwnsAccount, runWithAuthIdentity } from '../../src/auth/identity'
import { readOidcConfig } from '../../src/auth/oidc-config'
import { createOidcIdentityProvider } from '../../src/auth/providers/oidc'
import { walletBindingStub } from '../../src/auth/wallet-binding-client'
import { handleIssueBindNonce } from '../../src/rpc/methods/issueBindNonce'
import { RATE_LIMITED } from '../../src/rpc/errors'
import type { Env } from '../../src/types/env'

const ISSUER = 'https://followup.example'

const CLIENT_ID = 'client_123'

const NOW = 1_700_000_000

const ACCOUNT = '0x10000000000000000000000000000000000000aa' as Address

let privateKey: CryptoKey

let publicJwk: JWK

beforeAll(async () => {
    const rsa = await generateKeyPair('RS256', { extractable: true })
    privateKey = rsa.privateKey
    publicJwk = await exportJWK(rsa.publicKey)
    publicJwk.kid = 'followup-rsa'
    publicJwk.alg = 'RS256'
    publicJwk.use = 'sig'
})

function baseEnv(overrides: Partial<Env> = {}): Env {
    const worker = env as unknown as Env

    return {
        ...worker,
        PRIVY_ENABLED: 'false',
        OIDC_ENABLED: 'true',
        OIDC_ISSUER: ISSUER,
        OIDC_JWKS_URL: 'https://followup.example/jwks',
        OIDC_CLIENT_ID: CLIENT_ID,
        CONTEXT: 'local',
        CHAIN_IDS: '31337,8453',
        WALLET_BINDING: worker.WALLET_BINDING,
        ...overrides,
    }
}

async function sign(claims: Record<string, unknown>, audience?: string | string[]): Promise<string> {
    const builder = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'followup-rsa', typ: 'JWT' })
        .setIssuer(ISSUER)
        .setSubject(typeof claims.sub === 'string' ? claims.sub : 'followup-user')
        .setIssuedAt(NOW)

    if (claims.exp !== undefined) builder.setExpirationTime(claims.exp as number)
    else if (!Object.prototype.hasOwnProperty.call(claims, 'exp')) builder.setExpirationTime(NOW + 600)

    if (claims.nbf !== undefined) builder.setNotBefore(claims.nbf as number)

    if (audience !== undefined) builder.setAudience(audience)

    return builder.sign(privateKey)
}

async function withJwks<T>(url: string, run: () => Promise<T>, fail?: 'timeout'): Promise<T> {
    const previous = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

        if (href === url) {
            if (fail === 'timeout') {
                const error = new Error('The operation was aborted due to timeout')
                error.name = 'TimeoutError'
                throw error
            }

            return new Response(JSON.stringify({ keys: [publicJwk] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }

        return previous(input, init)
    }

    try {
        return await run()
    } finally {
        globalThis.fetch = previous
    }
}

function address(n: number): Address {
    return getAddress(`0x${(0xa000 + n).toString(16).padStart(40, '0')}`)
}

describe('oidc review follow-ups', () => {
    it('rejects a mismatched aud even when client_id matches, checks azp for an array aud, and requires exp', async () => {
        const url = 'https://followup.example/jwks/aud'
        const provider = createOidcIdentityProvider()
        const workerEnv = baseEnv({ OIDC_JWKS_URL: url })

        const mismatched = await sign(
            { sub: 'aud-client', client_id: CLIENT_ID },
            'https://resource.example',
        )

        const arrayWrongAzp = await sign(
            { sub: 'aud-array', azp: 'https://other.example' },
            [CLIENT_ID, 'https://other.example'],
        )

        const arrayRightAzp = await sign({ sub: 'aud-array-ok', azp: CLIENT_ID }, [
            CLIENT_ID,
            'https://other.example',
        ])

        const noExp = await sign({ sub: 'no-exp', exp: undefined, aud: CLIENT_ID })
        const clientOnly = await sign({ sub: 'client-only', client_id: CLIENT_ID })

        await withJwks(url, async () => {
            expect(await provider.verify(mismatched, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: false,
                code: 'INVALID_TOKEN',
            })
            expect(await provider.verify(arrayWrongAzp, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: false,
                code: 'INVALID_TOKEN',
            })
            expect(await provider.verify(arrayRightAzp, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: true,
                userId: 'aud-array-ok',
            })
            expect(await provider.verify(noExp, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: false,
                code: 'INVALID_TOKEN',
            })
            expect(await provider.verify(clientOnly, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: true,
                userId: 'client-only',
            })
        })
    })

    it('ignores a wallets claim unless the flag is on, and an empty claim name stays off', async () => {
        const url = 'https://followup.example/jwks/wallets'
        const provider = createOidcIdentityProvider()
        const claimed = '0x20000000000000000000000000000000000000bb' as Address
        const token = await sign({ sub: 'claim-attacker', wallets: [claimed] }, CLIENT_ID)
        const off = baseEnv({ OIDC_JWKS_URL: url })

        const emptyName = baseEnv({
            OIDC_JWKS_URL: url,
            OIDC_WALLETS_CLAIM_ENABLED: 'true',
            OIDC_WALLETS_CLAIM: '',
        })

        await withJwks(url, async () => {
            const ignored = await provider.verify(token, { env: off, nowSeconds: NOW })
            expect(ignored).toMatchObject({ ok: true, userId: 'claim-attacker', boundAccounts: [] })

            if (ignored.ok) {
                runWithAuthIdentity(
                    {
                        provider: 'oidc',
                        userId: ignored.userId,
                        issuer: ignored.issuer,
                        boundAccounts: ignored.boundAccounts,
                    },
                    () => {
                        expect(authIdentityOwnsAccount(claimed)).toBe(false)
                    },
                )
            }

            const empty = await provider.verify(token, { env: emptyName, nowSeconds: NOW })
            expect(empty).toMatchObject({ ok: true, boundAccounts: [] })
        })
    })

    it('does not treat an address-shaped OIDC sub as ownership', () => {
        runWithAuthIdentity(
            { provider: 'oidc', userId: ACCOUNT, issuer: ISSUER, boundAccounts: [] },
            () => {
                expect(authIdentityOwnsAccount(ACCOUNT)).toBe(false)
            },
        )
        runWithAuthIdentity({ provider: 'erc8128', userId: ACCOUNT }, () => {
            expect(authIdentityOwnsAccount(ACCOUNT)).toBe(true)
        })
    })

    it('rate-limits bind nonce issuance per subject and per IP and caps rows', async () => {
        const store = walletBindingStub(baseEnv())
        const issuer = 'https://followup.example/rate'
        const subject = 'rate-subject'
        let now = NOW

        for (let attempt = 0; attempt < 5; attempt++) {
            const issued = await store.issueNonce({
                issuer,
                subject,
                address: address(attempt),
                chainId: 31337,
                nowSeconds: now,
                ttlSeconds: 1,
                ip: `203.0.113.${attempt + 1}`,
            })

            expect(issued.ok).toBe(true)
            now += 2
        }

        const sixth = await store.issueNonce({
            issuer,
            subject,
            address: address(5),
            chainId: 31337,
            nowSeconds: now,
            ttlSeconds: 1,
            ip: '203.0.113.50',
        })

        expect(sixth).toMatchObject({ ok: false, reason: 'rate_limited' })

        const ip = '198.51.100.10'

        for (let attempt = 0; attempt < 20; attempt++) {
            const issued = await store.issueNonce({
                issuer,
                subject: `ip-subject-${attempt}`,
                address: address(100 + attempt),
                chainId: 31337,
                nowSeconds: NOW,
                ttlSeconds: 60,
                ip,
            })

            expect(issued.ok).toBe(true)
        }

        const pastIp = await store.issueNonce({
            issuer,
            subject: 'ip-subject-20',
            address: address(130),
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 60,
            ip,
        })

        expect(pastIp).toMatchObject({ ok: false, reason: 'rate_limited' })

        const capped = 'cap-subject'

        for (let attempt = 0; attempt < 3; attempt++) {
            const issued = await store.issueNonce({
                issuer,
                subject: capped,
                address: address(200 + attempt),
                chainId: 31337,
                nowSeconds: NOW + 10_000,
                ttlSeconds: 600,
                ip: `203.0.113.${80 + attempt}`,
            })

            expect(issued.ok).toBe(true)
        }

        const fourthOpen = await store.issueNonce({
            issuer,
            subject: capped,
            address: address(203),
            chainId: 31337,
            nowSeconds: NOW + 10_000,
            ttlSeconds: 600,
            ip: '203.0.113.90',
        })

        expect(fourthOpen).toMatchObject({ ok: false, reason: 'subject_cap' })

        const binder = 'bind-cap'
        const bindNow = NOW + 20_000

        for (let attempt = 0; attempt < 4; attempt++) {
            const issued = await store.issueNonce({
                issuer,
                subject: binder,
                address: address(700 + attempt),
                chainId: 31337,
                nowSeconds: bindNow,
                ttlSeconds: 600,
                ip: `192.0.2.${attempt + 1}`,
            })

            expect(issued.ok).toBe(true)

            if (!issued.ok) return
            expect(
                await store.bind({
                    nonce: issued.nonce,
                    issuer,
                    subject: binder,
                    address: address(700 + attempt),
                    chainId: 31337,
                    expiry: issued.expiresAt,
                    nowSeconds: bindNow,
                    ip: `192.0.2.${attempt + 1}`,
                }),
            ).toEqual({ ok: true })
        }

        const fifth = await store.issueNonce({
            issuer,
            subject: binder,
            address: address(704),
            chainId: 31337,
            nowSeconds: bindNow,
            ttlSeconds: 600,
            ip: '192.0.2.9',
        })

        expect(fifth).toMatchObject({ ok: false, reason: 'subject_cap' })
    })

    it('deletes a nonce once it is used or expired', async () => {
        const store = walletBindingStub(baseEnv())
        const issuer = 'https://followup.example/cleanup'

        const issued = await store.issueNonce({
            issuer,
            subject: 'cleanup-user',
            address: address(300),
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 600,
            ip: '203.0.113.70',
        })

        expect(issued.ok).toBe(true)

        if (!issued.ok) return
        expect(
            await store.bind({
                nonce: issued.nonce,
                issuer,
                subject: 'cleanup-user',
                address: address(300),
                chainId: 31337,
                expiry: issued.expiresAt,
                nowSeconds: NOW,
                ip: '203.0.113.70',
            }),
        ).toEqual({ ok: true })
        expect(
            await store.bind({
                nonce: issued.nonce,
                issuer,
                subject: 'cleanup-user',
                address: address(300),
                chainId: 31337,
                expiry: issued.expiresAt,
                nowSeconds: NOW + 1,
                ip: '203.0.113.71',
            }),
        ).toEqual({ ok: false, reason: 'nonce_unknown' })

        const expiring = await store.issueNonce({
            issuer,
            subject: 'cleanup-user',
            address: address(301),
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 30,
            ip: '203.0.113.72',
        })

        expect(expiring.ok).toBe(true)

        if (!expiring.ok) return
        expect(
            await store.bind({
                nonce: expiring.nonce,
                issuer,
                subject: 'cleanup-user',
                address: address(301),
                chainId: 31337,
                expiry: expiring.expiresAt,
                nowSeconds: expiring.expiresAt,
                ip: '203.0.113.72',
            }),
        ).toEqual({ ok: false, reason: 'nonce_expired' })
        expect(
            await store.bind({
                nonce: expiring.nonce,
                issuer,
                subject: 'cleanup-user',
                address: address(301),
                chainId: 31337,
                expiry: expiring.expiresAt,
                nowSeconds: expiring.expiresAt + 1,
                ip: '203.0.113.73',
            }),
        ).toEqual({ ok: false, reason: 'nonce_unknown' })
    })

    it('maps a JWKS fetch timeout to IDP_UNAVAILABLE', async () => {
        const url = 'https://followup.example/jwks/timeout'
        const provider = createOidcIdentityProvider()
        const token = await sign({ sub: 'timeout-user' }, CLIENT_ID)

        const result = await withJwks(
            url,
            () => provider.verify(token, { env: baseEnv({ OIDC_JWKS_URL: url }), nowSeconds: NOW }),
            'timeout',
        )

        expect(result).toMatchObject({ ok: false, code: 'IDP_UNAVAILABLE' })
        expect(new errors.JWKSTimeout().message).toBe('request timed out')
    })

    it('refuses an http JWKS URL outside local', () => {
        const httpJwks = {
            OIDC_ISSUER: 'https://issuer.example',
            OIDC_JWKS_URL: 'http://issuer.example/jwks',
            OIDC_CLIENT_ID: CLIENT_ID,
        } as Env

        expect(readOidcConfig({ ...httpJwks, CONTEXT: 'stage' }).ok).toBe(false)
        expect(readOidcConfig({ ...httpJwks, CONTEXT: 'prod' }).ok).toBe(false)
        expect(readOidcConfig({ ...httpJwks, CONTEXT: 'local' }).ok).toBe(true)
        expect(readOidcConfig({ ...httpJwks, CONTEXT: 'dev' }).ok).toBe(false)
    })

    it('uses a nubl EIP-712 domain whose salt differs for stage and prod', async () => {
        const account = address(400)

        const stage = await runWithAuthIdentity(
            { provider: 'oidc', userId: 'domain-stage', issuer: ISSUER },
            () =>
                handleIssueBindNonce(
                    { address: account, chainId: '0x7a69' },
                    {
                        env: baseEnv({ CONTEXT: 'stage', CHAIN_IDS: '31337' }),
                        request: new Request('https://relayer.local/', {
                            headers: { 'cf-connecting-ip': '203.0.113.40' },
                        }),
                    },
                ),
        )

        const prod = await runWithAuthIdentity(
            { provider: 'oidc', userId: 'domain-prod', issuer: ISSUER },
            () =>
                handleIssueBindNonce(
                    { address: address(401), chainId: '0x7a69' },
                    {
                        env: baseEnv({ CONTEXT: 'prod', CHAIN_IDS: '31337' }),
                        request: new Request('https://relayer.local/', {
                            headers: { 'cf-connecting-ip': '203.0.113.41' },
                        }),
                    },
                ),
        )

        expect(stage.typedData.domain.name).toBe('Nubl Relayer')
        expect(stage.typedData.domain.salt).toBeTypeOf('string')
        expect(stage.typedData.domain.salt).not.toBe(prod.typedData.domain.salt)
        expect(stage.message).toContain('Environment: stage')
        expect(prod.message).toContain('Environment: prod')
    })

    it('sets PRIVY_ENABLED explicitly on the stage and prod wrangler configs', () => {
        const stage = wranglerToml.match(/\[env\.stage\][\s\S]*?(?=\n\[env\.|\n\[\[env\.|$)/)
        const prod = wranglerToml.match(/\[env\.prod\][\s\S]*?(?=\n\[env\.|\n\[\[env\.|$)/)
        expect(stage?.[0]).toMatch(/PRIVY_ENABLED\s*=\s*"true"/)
        expect(prod?.[0]).toMatch(/PRIVY_ENABLED\s*=\s*"true"/)
    })

    it('keeps wallet binding global across chains', async () => {
        const mod = await import('../../src/durable-objects/wallet-binding.do')
        expect(mod.WALLET_BINDING_SCOPE).toBe('global')

        const store = walletBindingStub(baseEnv())
        const shared = address(500)
        const issuer = 'https://followup.example/global'

        const issued = await store.issueNonce({
            issuer,
            subject: 'global-owner',
            address: shared,
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 600,
            ip: '203.0.113.60',
        })

        expect(issued.ok).toBe(true)

        if (!issued.ok) return
        expect(
            await store.bind({
                nonce: issued.nonce,
                issuer,
                subject: 'global-owner',
                address: shared,
                chainId: 31337,
                expiry: issued.expiresAt,
                nowSeconds: NOW,
                ip: '203.0.113.60',
            }),
        ).toEqual({ ok: true })

        const otherChain = await store.issueNonce({
            issuer,
            subject: 'global-other',
            address: shared,
            chainId: 8453,
            nowSeconds: NOW,
            ttlSeconds: 600,
            ip: '203.0.113.61',
        })

        expect(otherChain).toEqual({ ok: false, reason: 'address_taken' })
        expect(await store.accountsFor(issuer, 'global-owner')).toEqual([shared.toLowerCase()])
    })

    it('returns RATE_LIMITED from wallet_issueBindNonce when the subject is over the cap', async () => {
        const workerEnv = baseEnv({ CHAIN_IDS: '31337' })

        const request = new Request('https://relayer.local/', {
            headers: { 'cf-connecting-ip': '203.0.113.15' },
        })

        for (let attempt = 0; attempt < 3; attempt++) {
            await runWithAuthIdentity({ provider: 'oidc', userId: 'rpc-cap', issuer: ISSUER }, () =>
                handleIssueBindNonce(
                    { address: address(600 + attempt), chainId: '0x7a69' },
                    { env: workerEnv, request },
                ),
            )
        }

        await expect(
            runWithAuthIdentity({ provider: 'oidc', userId: 'rpc-cap', issuer: ISSUER }, () =>
                handleIssueBindNonce(
                    { address: address(603), chainId: '0x7a69' },
                    { env: workerEnv, request },
                ),
            ),
        ).rejects.toMatchObject({ code: RATE_LIMITED })
    })
})
