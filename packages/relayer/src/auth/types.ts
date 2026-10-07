import type { Env } from '../types/env'
import type { Address } from 'viem'

export type AuthFailureCode =
    | 'MISSING_HEADERS'
    | 'BAD_FORMAT'
    | 'BAD_KEYID'
    | 'SIGNER_NOT_ALLOWED'
    | 'UNSUPPORTED_CHAIN'
    | 'INVALID_TIME'
    | 'INVALID_COVERAGE'
    | 'MISSING_NONCE'
    | 'REPLAYED_NONCE'
    | 'BAD_CONTENT_DIGEST'
    | 'BAD_SIGNATURE'
    | 'INVALID_TOKEN'
    | 'EXPIRED_TOKEN'
    | 'NO_LINKED_WALLET'
    /** OIDC JWKS and other identity-provider outages. */
    | 'IDP_UNAVAILABLE'
    /**
     * Privy upstream outage. Still emitted for Privy, and accepted as an alias
     * of `IDP_UNAVAILABLE` so existing clients keep matching it.
     */
    | 'PRIVY_API_UNAVAILABLE'

export interface AuthFailure {
    ok: false
    code: AuthFailureCode
    message: string
    /**
     * The token's issuer belongs to another provider. The engine drops this
     * when a provider that did accept the token produced a real result, so a
     * JWKS or Privy outage is not hidden behind "invalid token".
     */
    routingMiss?: boolean
}

/** Privy still emits `PRIVY_API_UNAVAILABLE`. OIDC emits `IDP_UNAVAILABLE`. Both count. */
export function isIdentityProviderUnavailable(code: string): boolean {
    return code === 'IDP_UNAVAILABLE' || code === 'PRIVY_API_UNAVAILABLE'
}

export interface AuthSuccess {
    ok: true
    userId?: Address | string
    provider?: string
    /** OIDC issuer, when the accepting provider is OIDC. */
    issuer?: string
    /** Accounts this identity may upgrade. */
    boundAccounts?: Address[]
}

export type AuthResult = AuthSuccess | AuthFailure

export interface AuthProvider {
    name: string
    enabled(env: Env): boolean
    verify(req: Request, ctx: { env: Env; nowSeconds: number }): Promise<AuthResult>
}
