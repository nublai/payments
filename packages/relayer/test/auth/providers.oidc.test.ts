import { env } from 'cloudflare:test'
import { exportJWK, exportSPKI, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'

import { authorizeRequest } from '../../src/auth/engine'
import { identityAuthProviders } from '../../src/auth/identity-registry'
import { createOidcIdentityProvider } from '../../src/auth/providers/oidc'
import { walletBindingStub } from '../../src/auth/wallet-binding-client'
import { isIdentityProviderUnavailable } from '../../src/auth/types'
import type {Env} from '../../src/types/env'
import { workerEnv } from '../helpers/env'
import type { PrivyAuthClient, PrivyIdentityDeps } from '../../src/auth/providers/privy'

const verifyAuthTokenMock = vi.fn<PrivyAuthClient['verifyAuthToken']>()

const createPrivyClient = vi.fn<NonNullable<PrivyIdentityDeps['createClient']>>((_appId, _appSecret) => ({
    verifyAuthToken: verifyAuthTokenMock,
    getUserByWalletAddress: vi.fn<PrivyAuthClient['getUserByWalletAddress']>(),
}))

function providers() {
    return identityAuthProviders({ privy: { createClient: createPrivyClient } })
}

const OIDC_SKEW = 60

const ISSUER = 'https://issuer.example'

const OTHER_ISSUER = 'https://other.example'

const CLIENT_ID = 'client_123'

const NOW = 1_700_000_000

const KID = 'test-rsa'

let privateKey: CryptoKey

let publicKey: CryptoKey

let publicJwk: JWK

let esPrivateKey: CryptoKey

let esPublicJwk: JWK

beforeAll(async () => {
    const rsa = await generateKeyPair('RS256', { extractable: true })
    privateKey = rsa.privateKey
    publicKey = rsa.publicKey
    publicJwk = await exportJWK(rsa.publicKey)
    publicJwk.kid = KID
    publicJwk.alg = 'RS256'
    publicJwk.use = 'sig'

    const ec = await generateKeyPair('ES256', { extractable: true })
    esPrivateKey = ec.privateKey
    esPublicJwk = await exportJWK(ec.publicKey)
    esPublicJwk.kid = 'test-es256'
    esPublicJwk.alg = 'ES256'
    esPublicJwk.use = 'sig'
})

function oidcEnv(jwksUrl: string, overrides: Partial<Env> = {}): Env {
    const base = workerEnv(env)

    return {
        ...base,
        PRIVY_ENABLED: 'true',
        PRIVY_APP_ID: 'app_123',
        PRIVY_APP_SECRET: 'secret_123',
        OIDC_ENABLED: 'true',
        OIDC_ISSUER: ISSUER,
        OIDC_JWKS_URL: jwksUrl,
        OIDC_CLIENT_ID: CLIENT_ID,
        WALLET_BINDING: base.WALLET_BINDING,
        ...overrides }
}

async function signToken(input: {
    privateKey?: CryptoKey
    kid?: string
    alg?: 'RS256' | 'ES256' | 'HS256'
    issuer?: string
    subject?: string
    audience?: string | string[]
    clientId?: string
    exp?: number
    nbf?: number
    wallets?: unknown
    walletsClaim?: string
    secret?: Uint8Array
}): Promise<string> {
    type SignTokenClaims = {
        client_id?: string
        wallets?: unknown
    }

    const claims: SignTokenClaims = {}

    if (input.clientId) claims.client_id = input.clientId

    if (input.wallets !== undefined) claims.wallets = input.wallets

    const builder = new SignJWT(claims)
        .setProtectedHeader({ alg: input.alg ?? 'RS256', kid: input.kid ?? KID, typ: 'JWT' })
        .setIssuer(input.issuer ?? ISSUER)
        .setSubject(input.subject ?? 'user_1')
        .setIssuedAt(NOW)
        .setExpirationTime(input.exp ?? NOW + 600)
        .setNotBefore(input.nbf ?? NOW - 10)

    if (input.audience !== undefined) builder.setAudience(input.audience)

    return builder.sign(input.secret ?? input.privateKey ?? privateKey)
}

async function withJwks<T>(
    url: string,
    jwks: { keys: JWK[] },
    run: () => Promise<T>,
    options?: { fail?: boolean },
): Promise<T> {
    const previous = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const href =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

        if (href === url) {
            if (options?.fail) throw new TypeError('fetch failed')

            return new Response(JSON.stringify(jwks), {
                status: 200,
                headers: { 'content-type': 'application/json' } })
        }

        return previous(input, init)
    }

    try {
        return await run()
    } finally {
        globalThis.fetch = previous
    }
}

function noneToken(payload: {
    iss: string
    sub: string
    aud: string
    exp: number
    nbf: number
    iat: number
}): string {
    const encode = (value: string) => {
        const bytes = new TextEncoder().encode(value)
        let binary = ''

        for (const byte of bytes) binary += String.fromCharCode(byte)

        return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    }

    const header = encode(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    const body = encode(JSON.stringify(payload))

    return `${header}.${body}.`
}

describe('oidc identity provider', () => {
    it('verifies Privy and OIDC tokens when both providers are enabled', async () => {
        verifyAuthTokenMock.mockReset()
        verifyAuthTokenMock.mockImplementation(async (token: string) => {
            if (token.includes('.')) throw new Error('invalid token')

            return { userId: 'did:privy:abc', appId: 'app_123' }
        })
        const url = 'https://issuer.example/jwks/both'
        const token = await signToken({ audience: CLIENT_ID, subject: 'oidc-user' })
        const workerEnv = oidcEnv(url)
        const provider = createOidcIdentityProvider()

        const oidc = await withJwks(url, { keys: [publicJwk] }, () =>
            provider.verify(token, { env: workerEnv, nowSeconds: NOW }),
        )

        expect(oidc).toMatchObject({
            ok: true,
            provider: 'oidc',
            userId: 'oidc-user',
            issuer: ISSUER,
            boundAccounts: [] })
        expect(verifyAuthTokenMock).not.toHaveBeenCalled()

        const privy = await authorizeRequest({
            request: new Request('https://relayer.local/', {
                headers: { Authorization: 'Bearer privy-token' } }),
            env: workerEnv,
            nowSeconds: NOW,
            providers: providers() })

        expect(privy).toMatchObject({ ok: true, provider: 'privy', userId: 'did:privy:abc' })

        const routed = await withJwks(url, { keys: [publicJwk] }, () =>
            authorizeRequest({
                request: new Request('https://relayer.local/', {
                    headers: { Authorization: `Bearer ${token}` } }),
                env: workerEnv,
                nowSeconds: NOW,
                providers: providers() }),
        )

        expect(routed).toMatchObject({ ok: true, provider: 'oidc', userId: 'oidc-user' })
    })

    it('verifies an OIDC token when Privy is disabled', async () => {
        const url = 'https://issuer.example/jwks/oidc-only'
        const token = await signToken({ audience: CLIENT_ID, subject: 'only-oidc' })
        const workerEnv = oidcEnv(url, { PRIVY_ENABLED: 'false' })

        const result = await withJwks(url, { keys: [publicJwk] }, () =>
            authorizeRequest({
                request: new Request('https://relayer.local/', {
                    headers: { Authorization: `Bearer ${token}` } }),
                env: workerEnv,
                nowSeconds: NOW,
                providers: providers() }),
        )

        expect(result).toMatchObject({ ok: true, provider: 'oidc', userId: 'only-oidc' })
        expect(identityAuthProviders().find((provider) => provider.name === 'privy')?.enabled(workerEnv)).toBe(
            false,
        )
    })

    it('accepts ES256 and caches the JWKS across verifies', async () => {
        const url = 'https://issuer.example/jwks/es256'

        const token = await signToken({
            privateKey: esPrivateKey,
            kid: 'test-es256',
            alg: 'ES256',
            audience: CLIENT_ID,
            subject: 'es-user' })

        const provider = createOidcIdentityProvider()
        const workerEnv = oidcEnv(url)
        let fetches = 0
        const previous = globalThis.fetch
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const href =
                typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

            if (href === url) {
                fetches += 1

                return new Response(JSON.stringify({ keys: [esPublicJwk] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' } })
            }

            return previous(input, init)
        }

        try {
            const first = await provider.verify(token, { env: workerEnv, nowSeconds: NOW })
            const second = await provider.verify(token, { env: workerEnv, nowSeconds: NOW })
            expect(first).toMatchObject({ ok: true, userId: 'es-user' })
            expect(second).toMatchObject({ ok: true, userId: 'es-user' })
            expect(fetches).toBe(1)
        } finally {
            globalThis.fetch = previous
        }
    })

    it('refuses the wrong issuer, audience, and an expired token', async () => {
        const url = 'https://issuer.example/jwks/claims'
        const provider = createOidcIdentityProvider()
        const workerEnv = oidcEnv(url)
        const wrongIss = await signToken({ issuer: OTHER_ISSUER, audience: CLIENT_ID })
        const wrongAud = await signToken({ audience: 'other-client', subject: 'wrong-aud' })

        const expired = await signToken({
            audience: CLIENT_ID,
            subject: 'expired-user',
            exp: NOW - OIDC_SKEW - 30 })

        const withinSkew = await signToken({
            audience: CLIENT_ID,
            subject: 'skew-user',
            exp: NOW - 30 })

        const clientIdOnly = await signToken({ clientId: CLIENT_ID, subject: 'client-user' })

        await withJwks(url, { keys: [publicJwk] }, async () => {
            expect(await provider.verify(wrongIss, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: false,
                code: 'INVALID_TOKEN' })
            expect(await provider.verify(wrongAud, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: false,
                code: 'INVALID_TOKEN' })
            expect(await provider.verify(expired, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: false,
                code: 'EXPIRED_TOKEN' })
            expect(await provider.verify(withinSkew, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: true,
                userId: 'skew-user' })
            expect(await provider.verify(clientIdOnly, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: true,
                userId: 'client-user' })
        })
    })

    it('refuses an unknown kid, HS256 signed with the public key, and alg none', async () => {
        const url = 'https://issuer.example/jwks/algs'
        const provider = createOidcIdentityProvider()
        const workerEnv = oidcEnv(url)
        const other = await generateKeyPair('RS256', { extractable: true })

        const unknown = await signToken({
            privateKey: other.privateKey,
            kid: 'not-in-set',
            audience: CLIENT_ID,
            subject: 'unknown-kid' })

        const spki = await exportSPKI(publicKey)

        const confused = await signToken({
            alg: 'HS256',
            audience: CLIENT_ID,
            subject: 'confused',
            secret: new TextEncoder().encode(spki) })

        const none = noneToken({
            iss: ISSUER,
            sub: 'none-user',
            aud: CLIENT_ID,
            exp: NOW + 600,
            nbf: NOW - 10,
            iat: NOW })

        await withJwks(url, { keys: [publicJwk] }, async () => {
            expect(await provider.verify(unknown, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: false,
                code: 'INVALID_TOKEN' })
            expect(await provider.verify(confused, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: false,
                code: 'INVALID_TOKEN' })
            expect(await provider.verify(none, { env: workerEnv, nowSeconds: NOW })).toMatchObject({
                ok: false,
                code: 'INVALID_TOKEN' })
        })
    })

    it('returns IDP_UNAVAILABLE when the JWKS fetch fails and still recognizes the Privy alias', async () => {
        const url = 'https://issuer.example/jwks/down'
        const provider = createOidcIdentityProvider()
        const token = await signToken({ audience: CLIENT_ID, subject: 'down-user' })

        const result = await withJwks(
            url,
            { keys: [] },
            () => provider.verify(token, { env: oidcEnv(url), nowSeconds: NOW }),
            { fail: true },
        )

        expect(result).toMatchObject({ ok: false, code: 'IDP_UNAVAILABLE' })

        if (!result.ok) {
            expect(isIdentityProviderUnavailable(result.code)).toBe(true)
        }

        expect(isIdentityProviderUnavailable('PRIVY_API_UNAVAILABLE')).toBe(true)
        expect(isIdentityProviderUnavailable('IDP_UNAVAILABLE')).toBe(true)

        const throughEngine = await withJwks(
            url,
            { keys: [] },
            () =>
                authorizeRequest({
                    request: new Request('https://relayer.local/', {
                        headers: { Authorization: `Bearer ${token}` } }),
                    env: oidcEnv(url),
                    nowSeconds: NOW,
                    providers: providers() }),
            { fail: true },
        )

        expect(throughEngine).toMatchObject({
            ok: false,
            code: 'IDP_UNAVAILABLE',
            message: 'OIDC JWKS unavailable' })

        verifyAuthTokenMock.mockReset()
        verifyAuthTokenMock.mockRejectedValueOnce(new Error('fetch failed'))

        const privyDown = await authorizeRequest({
            request: new Request('https://relayer.local/', {
                headers: { Authorization: 'Bearer privy-token' } }),
            env: oidcEnv(url),
            nowSeconds: NOW,
            providers: providers() })

        expect(privyDown).toMatchObject({
            ok: false,
            code: 'PRIVY_API_UNAVAILABLE',
            message: 'Privy API unavailable' })
    })

    it('fills bound accounts from the table and refuses a conflicting wallets claim', async () => {
        const url = 'https://issuer.example/jwks/wallets'
        const workerEnv = oidcEnv(url, { OIDC_WALLETS_CLAIM_ENABLED: 'true' })
        const store = walletBindingStub(workerEnv)
        const taken = '0x2000000000000000000000000000000000000001'
        const free = '0x2000000000000000000000000000000000000002'

        const issued = await store.issueNonce({
            issuer: ISSUER,
            subject: 'table-owner',
            address: taken,
            chainId: 31337,
            nowSeconds: NOW,
            ttlSeconds: 600 })

        expect(issued.ok).toBe(true)

        if (!issued.ok) return
        expect(
            await store.bind({
                nonce: issued.nonce,
                issuer: ISSUER,
                subject: 'table-owner',
                address: taken,
                chainId: 31337,
                expiry: issued.expiresAt,
                nowSeconds: NOW }),
        ).toEqual({ ok: true })

        const provider = createOidcIdentityProvider()
        const ownerToken = await signToken({ audience: CLIENT_ID, subject: 'table-owner' })

        const claimToken = await signToken({
            audience: CLIENT_ID,
            subject: 'table-owner',
            wallets: [taken] })

        const conflict = await signToken({
            audience: CLIENT_ID,
            subject: 'table-other',
            wallets: [taken, free] })

        const claimOnly = await signToken({
            audience: CLIENT_ID,
            subject: 'table-claim',
            wallets: [free] })

        await withJwks(url, { keys: [publicJwk] }, async () => {
            const fromTable = await provider.verify(ownerToken, { env: workerEnv, nowSeconds: NOW })
            expect(fromTable).toMatchObject({
                ok: true,
                boundAccounts: [getAddress(taken)] })
            const fromBoth = await provider.verify(claimToken, { env: workerEnv, nowSeconds: NOW })
            expect(fromBoth).toMatchObject({ ok: true, boundAccounts: [getAddress(taken)] })
            const refused = await provider.verify(conflict, { env: workerEnv, nowSeconds: NOW })
            expect(refused).toMatchObject({
                ok: false,
                code: 'NO_LINKED_WALLET' })
            const claimed = await provider.verify(claimOnly, { env: workerEnv, nowSeconds: NOW })
            expect(claimed).toMatchObject({ ok: true, boundAccounts: [getAddress(free)] })
        })
    })
})
