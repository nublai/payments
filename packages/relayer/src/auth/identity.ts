import { AsyncLocalStorage } from 'node:async_hooks'
import { getAddress, isAddress, type Address } from 'viem'

export interface AuthIdentity {
    provider: string
    userId: string
    /** OIDC issuer. Included in the rate-limit key. */
    issuer?: string
    boundAccounts?: Address[]
}

const authIdentityStorage = new AsyncLocalStorage<AuthIdentity>()

export function runWithAuthIdentity<T>(identity: AuthIdentity, fn: () => T): T {
    return authIdentityStorage.run(identity, fn)
}

export function currentAuthIdentity(): AuthIdentity | undefined {
    return authIdentityStorage.getStore()
}

/**
 * ERC-8128 identities are the signing address. Privy and OIDC identities are
 * not addresses; the provider sets boundAccounts from the linked wallet or
 * the binding table.
 */
export function authIdentityOwnsAccount(account: Address): boolean {
    const identity = authIdentityStorage.getStore()
    if (!identity) return false

    const target = getAddress(account)
    if (identity.boundAccounts?.some((candidate) => getAddress(candidate) === target)) {
        return true
    }

    return isAddress(identity.userId) && getAddress(identity.userId) === target
}

/**
 * Budget key. Privy and OIDC are namespaced so a shared user id string does
 * not share a bucket. Other providers keep the raw user id.
 */
export function rateLimitIdentityKey(identity: AuthIdentity): string {
    const userId = identity.userId.toLowerCase()
    if (identity.provider === 'privy') return `privy:${userId}`
    if (identity.provider === 'oidc') {
        return `oidc:${(identity.issuer ?? '').toLowerCase()}:${userId}`
    }
    return userId
}

/** Budget key. One authenticated caller cannot spend another caller's quota. */
export function upgradeRateIdentity(account: Address): string {
    const identity = authIdentityStorage.getStore()
    if (identity?.userId) return rateLimitIdentityKey(identity)
    return getAddress(account).toLowerCase()
}
