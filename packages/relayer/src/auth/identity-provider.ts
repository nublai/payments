import type { Address } from 'viem'

import type { Env } from '../types/env'
import type { AuthFailure, AuthProvider, AuthResult, AuthSuccess } from './types'

/**
 * Sponsored-upgrade identity. Privy and OIDC implement this shape.
 * Rate-limit keys are `privy:<user id>` and `oidc:<issuer>:<sub>`.
 */
export interface IdentitySuccess {
    ok: true
    provider: string
    userId: string
    /** Set for OIDC. Rate-limit keys include it so two issuers do not share a bucket. */
    issuer?: string
    /** Empty when the identity has no bound wallet yet. */
    boundAccounts: Address[]
}

export type IdentityFailure = AuthFailure

export type IdentityResult = IdentitySuccess | IdentityFailure

export interface IdentityContext {
    env: Env
    nowSeconds: number
}

export interface IdentityProvider {
    name: string
    enabled(env: Env): boolean
    verify(input: Request | string, ctx: IdentityContext): Promise<IdentityResult>
}

/**
 * Adapt an identity provider to the HTTP auth list. The engine still stamps
 * `provider` from `name`, and an empty `boundAccounts` stays omitted so the
 * existing Privy auth result shape does not change.
 */
export function authProviderFromIdentity(identity: IdentityProvider): AuthProvider {
    return {
        name: identity.name,
        enabled(env: Env): boolean {
            return identity.enabled(env)
        },
        async verify(request: Request, ctx: IdentityContext): Promise<AuthResult> {
            const result = await identity.verify(request, ctx)
            if (!result.ok) return result
            const success: AuthSuccess = { ok: true, userId: result.userId }
            if (result.issuer) success.issuer = result.issuer
            if (result.boundAccounts.length > 0) {
                success.boundAccounts = result.boundAccounts
            }
            return success
        },
    }
}
