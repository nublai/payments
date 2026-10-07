import { getAddress, isAddress, type Address } from 'viem'
import {
    createRemoteJWKSet,
    decodeProtectedHeader,
    errors,
    jwtVerify,
    type JWTPayload,
} from 'jose'

import type { Env } from '../../types/env'
import { peekJwtHasAudience, peekJwtIssuer } from '../jwt-peek'
import { isOidcEnabled, readOidcConfig } from '../oidc-config'
import {
    authProviderFromIdentity,
    type IdentityProvider,
    type IdentityResult,
} from '../identity-provider'
import { walletBindingStub } from '../wallet-binding-client'
import type { AuthProvider } from '../types'

/** RS256 and ES256 only. `none` and every HS* algorithm are rejected. */
export const OIDC_ALGORITHMS = ['RS256', 'ES256'] as const
export const OIDC_CLOCK_SKEW_SECONDS = 60
const MAX_WALLETS_CLAIM = 16

/**
 * One JWKS getter per URL for the life of the isolate. `createRemoteJWKSet`
 * caches the document, and keeping the getter here shares that cache across
 * requests instead of building a new one per verify.
 */
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export function oidcRemoteJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
    const existing = jwksByUrl.get(jwksUrl)
    if (existing) return existing
    const created = createRemoteJWKSet(new URL(jwksUrl), {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60 * 1000,
    })
    jwksByUrl.set(jwksUrl, created)
    return created
}

function requestFromIdentityInput(input: Request | string): Request {
    if (typeof input !== 'string') return input
    return new Request('https://relayer.local/', {
        headers: { Authorization: `Bearer ${input}` },
    })
}

function parseBearerToken(
    request: Request,
): { ok: true; token: string } | { ok: false; message: string } {
    const header = request.headers.get('Authorization')
    if (!header) {
        return { ok: false, message: 'Missing Authorization header' }
    }
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match || !match[1] || match[1].trim().length === 0) {
        return { ok: false, message: 'Invalid Authorization header format' }
    }
    return { ok: true, token: match[1].trim() }
}

function audienceMatches(payload: JWTPayload, clientId: string): boolean {
    const audience = payload.aud
    if (audience == null) {
        return payload.client_id === clientId
    }
    if (typeof audience === 'string') return audience === clientId
    if (Array.isArray(audience)) {
        return audience.includes(clientId) && payload.azp === clientId
    }
    return false
}

function parseWalletsClaim(payload: JWTPayload, claimName: string): Address[] | 'invalid' {
    if (!Object.prototype.hasOwnProperty.call(payload, claimName)) return []
    const raw = payload[claimName]
    if (raw == null) return []
    const items = Array.isArray(raw) ? raw : [raw]
    if (items.length > MAX_WALLETS_CLAIM) return 'invalid'
    const accounts: Address[] = []
    for (const item of items) {
        const value =
            typeof item === 'string'
                ? item
                : item &&
                    typeof item === 'object' &&
                    'address' in item &&
                    typeof (item as { address?: unknown }).address === 'string'
                  ? (item as { address: string }).address
                  : undefined
        if (!value || !isAddress(value)) return 'invalid'
        const account = getAddress(value)
        if (!accounts.includes(account)) accounts.push(account)
    }
    return accounts
}

function classifyOidcError(error: unknown): IdentityResult {
    if (error instanceof errors.JWTExpired) {
        return { ok: false, code: 'EXPIRED_TOKEN', message: 'Token has expired' }
    }
    if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JOSEAlgNotAllowed) {
        return { ok: false, code: 'INVALID_TOKEN', message: 'Invalid or expired token' }
    }
    if (error instanceof errors.JWKSTimeout) {
        return { ok: false, code: 'IDP_UNAVAILABLE', message: 'OIDC JWKS unavailable' }
    }
    if (error instanceof errors.JWTClaimValidationFailed) {
        if (error.claim === 'exp' && error.reason !== 'missing') {
            return { ok: false, code: 'EXPIRED_TOKEN', message: 'Token has expired' }
        }
        return { ok: false, code: 'INVALID_TOKEN', message: 'Invalid or expired token' }
    }
    if (isJwksUnavailable(error)) {
        return { ok: false, code: 'IDP_UNAVAILABLE', message: 'OIDC JWKS unavailable' }
    }
    if (
        error instanceof errors.JWSInvalid ||
        error instanceof errors.JWSSignatureVerificationFailed ||
        error instanceof errors.JWTInvalid
    ) {
        return { ok: false, code: 'INVALID_TOKEN', message: 'Invalid or expired token' }
    }
    return { ok: false, code: 'INVALID_TOKEN', message: 'Invalid or expired token' }
}

function isJwksUnavailable(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
    return (
        message.includes('fetch failed') ||
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('unavailable') ||
        message.includes('jwks') ||
        message.includes('expected 200') ||
        message.includes('503') ||
        message.includes('502') ||
        message.includes('500')
    )
}

export function createOidcIdentityProvider(): IdentityProvider {
    return {
        name: 'oidc',
        enabled(env: Env): boolean {
            return isOidcEnabled(env)
        },
        async verify(input: Request | string, ctx: { env: Env; nowSeconds: number }): Promise<IdentityResult> {
            const request = requestFromIdentityInput(input)
            const parsed = parseBearerToken(request)
            if (!parsed.ok) {
                return { ok: false, code: 'INVALID_TOKEN', message: parsed.message }
            }

            const configResult = readOidcConfig(ctx.env)
            if (!configResult.ok) {
                return { ok: false, code: 'IDP_UNAVAILABLE', message: 'OIDC provider is not configured' }
            }
            const config = configResult.config

            if (peekJwtIssuer(parsed.token) !== config.issuer) {
                return {
                    ok: false,
                    code: 'INVALID_TOKEN',
                    message: 'Token issuer mismatch',
                    routingMiss: true,
                }
            }

            let headerAlg: string | undefined
            try {
                headerAlg = decodeProtectedHeader(parsed.token).alg
            } catch {
                return { ok: false, code: 'INVALID_TOKEN', message: 'Invalid or expired token' }
            }
            if (headerAlg !== 'RS256' && headerAlg !== 'ES256') {
                return { ok: false, code: 'INVALID_TOKEN', message: 'Unsupported token algorithm' }
            }

            let payload: JWTPayload
            try {
                const verified = await jwtVerify(parsed.token, oidcRemoteJwks(config.jwksUrl), {
                    issuer: config.issuer,
                    algorithms: [...OIDC_ALGORITHMS],
                    clockTolerance: OIDC_CLOCK_SKEW_SECONDS,
                    currentDate: new Date(ctx.nowSeconds * 1000),
                    requiredClaims: ['exp'],
                    ...(peekJwtHasAudience(parsed.token) ? { audience: config.clientId } : {}),
                })
                payload = verified.payload
            } catch (error) {
                return classifyOidcError(error)
            }

            if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 256) {
                return { ok: false, code: 'INVALID_TOKEN', message: 'Invalid or expired token' }
            }
            if (!audienceMatches(payload, config.clientId)) {
                return { ok: false, code: 'INVALID_TOKEN', message: 'Token audience mismatch' }
            }

            const claimed = config.walletsClaim
                ? parseWalletsClaim(payload, config.walletsClaim)
                : []
            if (claimed === 'invalid') {
                return { ok: false, code: 'INVALID_TOKEN', message: 'Invalid wallets claim' }
            }

            let stored: Address[]
            try {
                const stub = walletBindingStub(ctx.env)
                const rows = await stub.accountsFor(config.issuer, payload.sub)
                stored = rows.map((row) => getAddress(row))
                for (const account of claimed) {
                    const owner = await stub.ownerOf(account)
                    if (owner && (owner.issuer !== config.issuer || owner.subject !== payload.sub)) {
                        return {
                            ok: false,
                            code: 'NO_LINKED_WALLET',
                            message: 'Wallet claim conflicts with the binding table',
                        }
                    }
                }
            } catch {
                return { ok: false, code: 'IDP_UNAVAILABLE', message: 'Wallet binding store unavailable' }
            }

            const boundAccounts: Address[] = []
            for (const account of [...stored, ...claimed]) {
                if (!boundAccounts.includes(account)) boundAccounts.push(account)
            }

            return {
                ok: true,
                provider: 'oidc',
                userId: payload.sub,
                issuer: config.issuer,
                boundAccounts,
            }
        },
    }
}

export function createOidcProvider(): AuthProvider {
    return authProviderFromIdentity(createOidcIdentityProvider())
}
