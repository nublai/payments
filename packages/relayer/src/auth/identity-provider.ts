import type { Address } from 'viem'

import type { Env } from '../types/env'
import type { AuthFailure, AuthProvider, AuthResult, AuthSuccess } from './types'

/**
 * Sponsored-upgrade identity. Privy is the first implementation. A later OIDC
 * provider implements this same shape and is added to the ordered registry.
 * Rate-limit keys stay the raw `userId` (no provider prefix).
 */
export interface IdentitySuccess {
    ok: true
    provider: string
    userId: string
    /** Empty when the request is not an account upgrade. */
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
            if (result.boundAccounts.length > 0) {
                success.boundAccounts = result.boundAccounts
            }
            return success
        },
    }
}
