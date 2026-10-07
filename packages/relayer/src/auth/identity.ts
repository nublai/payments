import { AsyncLocalStorage } from 'node:async_hooks'
import { getAddress, isAddress, type Address } from 'viem'

export interface AuthIdentity {
    provider: string
    userId: string
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
 * ERC-8128 identities are the signing address. Privy identities are not
 * addresses; the provider sets boundAccounts after checking the linked wallet.
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

/** Budget key. One authenticated caller cannot spend another caller's quota. */
export function upgradeRateIdentity(account: Address): string {
    const identity = authIdentityStorage.getStore()
    if (identity?.userId) return identity.userId.toLowerCase()
    return getAddress(account).toLowerCase()
}
