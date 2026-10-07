import type { AuthProvider } from './types'
import { authProviderFromIdentity, type IdentityProvider } from './identity-provider'
import { createPrivyIdentityProvider } from './providers/privy'

/**
 * Ordered identity providers for the sponsored upgrade.
 *
 * The first enabled provider that accepts the bearer token wins. Adding the
 * follow-up OIDC/WorkOS provider is a new entry in this list plus its env
 * flag. `authIdentityOwnsAccount` and `upgradeRateIdentity` stay as they are:
 * bucket keys are still the raw user id, with no provider prefix.
 */
export function createIdentityProviders(): IdentityProvider[] {
    return [createPrivyIdentityProvider()]
}

export function identityAuthProviders(): AuthProvider[] {
    return createIdentityProviders().map(authProviderFromIdentity)
}
