import type { AuthProvider } from './types'
import { authProviderFromIdentity, type IdentityProvider } from './identity-provider'
import { createOidcIdentityProvider } from './providers/oidc'
import { createPrivyIdentityProvider } from './providers/privy'

/**
 * Ordered identity providers for the sponsored upgrade.
 *
 * The first enabled provider that accepts the bearer token wins. Privy stays
 * first. An OIDC token is routed by `iss` before Privy calls its API. Bucket
 * keys are `privy:<user id>` and `oidc:<issuer>:<sub>`.
 */
export function createIdentityProviders(): IdentityProvider[] {
    return [createPrivyIdentityProvider(), createOidcIdentityProvider()]
}

export function identityAuthProviders(): AuthProvider[] {
    return createIdentityProviders().map(authProviderFromIdentity)
}
