import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { INTENT_EXPIRY_TTL_SECONDS, type Call } from '@nubl/relayer-client'
import { accountAbi } from '@nubl/contracts/abis'

/**
 * Account.Key.expiry already exists (0 = never). Orchestrator intent expiry
 * does not clear canExecute or a minute spend limit. The quote installer sets
 * this key's expiry so a dead process cannot keep the approve grant forever.
 *
 * The key has to stay valid through an intent signed after install, so the
 * window is two intent TTLs (2 hours). Recovery writes the previous expiry
 * back only when the on-chain key still equals what install wrote: that
 * bounded expiry, the same key material, the same canExecute permissions, and
 * the same spend limits. If any of those differ, recovery does not authorize
 * and does not touch the key. The approve grant and the raised minute limit
 * then stay until the on-chain expiry. Install bounded that expiry to
 * now+7200, the same window as a process that dies before cleanup. Spent
 * counters, period start, and signature-checker sets are not part of this
 * comparison. If recovery never runs, the key stops signing when this expiry
 * passes. The grant and the minute limit remain in storage and cannot be used.
 *
 * No new storage, no bytecode change, no redeploy. The root key sends the
 * existing `authorize` call, which updates expiry when the key already exists.
 */
export const QUOTE_KEY_EXPIRY_SECONDS = INTENT_EXPIRY_TTL_SECONDS * 2n

export type QuoteKeyMaterial = {
    expiry: bigint
    keyType: number
    isSuperAdmin: boolean
    publicKey: Hex
}

export type QuoteKeyPermission = {
    target: Address
    selector: Hex
}

export type QuoteKeyLimit = {
    token: Address
    /** GuardedExecutor.SpendPeriod. Minute is 0. */
    period: number
    limit: bigint
}

/** The key as install left it, or as a later read found it. */
export type QuoteKeySnapshot = QuoteKeyMaterial & {
    permissions: readonly QuoteKeyPermission[]
    limits: readonly QuoteKeyLimit[]
}

export type QuoteKeyExpiryPlan = {
    previous: bigint
    installed: bigint
    changed: boolean
}

/** A sooner non-zero expiry is left alone. Zero means the key never expires. */
export function planQuoteKeyExpiry(input: {
    now: bigint
    currentExpiry: bigint
}): QuoteKeyExpiryPlan {
    const installed = input.now + QUOTE_KEY_EXPIRY_SECONDS
    if (installed > 2n ** 40n - 1n) {
        throw new Error('Quote key expiry does not fit in uint40.')
    }
    if (input.currentExpiry !== 0n && input.currentExpiry <= installed) {
        return { previous: input.currentExpiry, installed: input.currentExpiry, changed: false }
    }
    return { previous: input.currentExpiry, installed, changed: true }
}

/**
 * What restore compares against. A stored permission or limit list is the
 * full post-install set. Older records omit that list: a missing call grant
 * is a difference, and each quoted minute slot must still be the installed
 * limit. Extra rows on those older records are not visible.
 */
export function expectedInstalledKey(input: {
    installedExpiry: bigint
    keyType: number
    isSuperAdmin: boolean
    publicKey: Hex
    storedPermissions?: readonly QuoteKeyPermission[]
    storedLimits?: readonly QuoteKeyLimit[]
    callGrants: readonly QuoteKeyPermission[]
    minuteSlots: readonly { token: Address; installedLimit: bigint }[]
    live: QuoteKeySnapshot
}): QuoteKeySnapshot {
    return {
        expiry: input.installedExpiry,
        keyType: input.keyType,
        isSuperAdmin: input.isSuperAdmin,
        publicKey: input.publicKey,
        permissions: input.storedPermissions
            ? input.storedPermissions
            : grantsStillPresent(input.callGrants, input.live.permissions)
              ? input.live.permissions
              : input.callGrants,
        limits: input.storedLimits
            ? input.storedLimits
            : expectedMinuteSlots(input.live.limits, input.minuteSlots),
    }
}

/**
 * Field-by-field differences between the key install wrote and the key now
 * on chain. Empty means restore may write the previous expiry back. Spent
 * counters, period start, and signature-checker sets are not compared.
 */
export function quoteKeyDifferences(installed: QuoteKeySnapshot, live: QuoteKeySnapshot): string[] {
    const differences: string[] = []
    if (installed.expiry !== live.expiry) {
        differences.push(`expiry: expected ${installed.expiry}, found ${live.expiry}`)
    }
    if (installed.publicKey.toLowerCase() !== live.publicKey.toLowerCase()) {
        differences.push(`publicKey: expected ${installed.publicKey}, found ${live.publicKey}`)
    }
    if (installed.keyType !== live.keyType) {
        differences.push(`keyType: expected ${installed.keyType}, found ${live.keyType}`)
    }
    if (installed.isSuperAdmin !== live.isSuperAdmin) {
        differences.push(
            `isSuperAdmin: expected ${installed.isSuperAdmin}, found ${live.isSuperAdmin}`,
        )
    }
    const expectedPermissions = formatPermissions(installed.permissions)
    const foundPermissions = formatPermissions(live.permissions)
    if (expectedPermissions !== foundPermissions) {
        differences.push(`permissions: expected ${expectedPermissions}, found ${foundPermissions}`)
    }
    const expectedLimits = formatLimits(installed.limits)
    const foundLimits = formatLimits(live.limits)
    if (expectedLimits !== foundLimits) {
        differences.push(`limits: expected ${expectedLimits}, found ${foundLimits}`)
    }
    return differences
}

/**
 * Restores the previous expiry only when the key still exists and still
 * matches what install wrote. `authorize` on a missing key would create it
 * again. A different expiry, permission, or limit returns no call.
 * Differences are appended to `differences` when that array is passed.
 */
export function restoreQuoteKeyExpiryCall(input: {
    account: Address
    previous: QuoteKeyMaterial | undefined
    keyStillExists: boolean
    /** Post-install key. Expiry is the bounded now+7200 value install set. */
    installed?: QuoteKeySnapshot
    /** getKey, canExecute, and spend limits as they are now. */
    live?: QuoteKeySnapshot
    differences?: string[]
}): Call[] {
    if (!input.previous || !input.keyStillExists) return []
    if (!input.installed || !input.live) return []
    const differences = quoteKeyDifferences(input.installed, input.live)
    if (differences.length > 0) {
        input.differences?.push(...differences)
        return []
    }
    return [
        authorizeKeyExpiryCall({
            account: input.account,
            key: input.previous,
            expiry: input.previous.expiry,
        }),
    ]
}

export function authorizeKeyExpiryCall(input: {
    account: Address
    key: QuoteKeyMaterial
    expiry: bigint
}): Call {
    return {
        target: input.account,
        value: 0n,
        data: encodeFunctionData({
            abi: accountAbi,
            functionName: 'authorize',
            args: [
                {
                    expiry: Number(input.expiry),
                    keyType: input.key.keyType,
                    isSuperAdmin: input.key.isSuperAdmin,
                    publicKey: input.key.publicKey,
                },
            ],
        }),
    }
}

/** Permissions install will have written: the key's current rows plus new grants. */
export function permissionsAfterInstall(
    current: readonly QuoteKeyPermission[],
    grants: readonly QuoteKeyPermission[],
): QuoteKeyPermission[] {
    const permissions = current.map(normalizePermission)
    for (const grant of grants) {
        const normalized = normalizePermission(grant)
        const id = permissionId(normalized)
        if (permissions.some((permission) => permissionId(permission) === id)) continue
        permissions.push(normalized)
    }
    return permissions
}

/** Spend limits install will have written. Minute slots (period 0) take the quote limit. */
export function limitsAfterInstall(
    current: readonly QuoteKeyLimit[],
    minuteSlots: readonly { token: Address; installedLimit: bigint }[],
): QuoteKeyLimit[] {
    return expectedMinuteSlots(current, minuteSlots)
}

const SPEND_PERIODS = ['minute', 'hour', 'day', 'week', 'month', 'year', 'forever'] as const

function grantsStillPresent(
    grants: readonly QuoteKeyPermission[],
    live: readonly QuoteKeyPermission[],
): boolean {
    const present = new Set(live.map((permission) => permissionId(normalizePermission(permission))))
    return grants.every((grant) => present.has(permissionId(normalizePermission(grant))))
}

function expectedMinuteSlots(
    live: readonly QuoteKeyLimit[],
    minuteSlots: readonly { token: Address; installedLimit: bigint }[],
): QuoteKeyLimit[] {
    const limits = live.map((limit) => ({
        token: getAddress(limit.token),
        period: limit.period,
        limit: limit.limit,
    }))
    for (const slot of minuteSlots) {
        const token = getAddress(slot.token)
        const index = limits.findIndex(
            (limit) => limit.token.toLowerCase() === token.toLowerCase() && limit.period === 0,
        )
        if (index >= 0) {
            limits[index] = { token, period: 0, limit: slot.installedLimit }
            continue
        }
        limits.push({ token, period: 0, limit: slot.installedLimit })
    }
    return limits
}

function normalizePermission(permission: QuoteKeyPermission): QuoteKeyPermission {
    return {
        target: getAddress(permission.target),
        selector: permission.selector.toLowerCase() as Hex,
    }
}

function permissionId(permission: QuoteKeyPermission): string {
    return `${permission.target.toLowerCase()}/${permission.selector.toLowerCase()}`
}

function formatPermissions(permissions: readonly QuoteKeyPermission[]): string {
    if (permissions.length === 0) return 'none'
    return permissions
        .map((permission) => permissionId(normalizePermission(permission)))
        .sort()
        .join(', ')
}

function formatLimits(limits: readonly QuoteKeyLimit[]): string {
    if (limits.length === 0) return 'none'
    return limits
        .map((limit) => {
            const period = SPEND_PERIODS[limit.period] ?? String(limit.period)
            return `${getAddress(limit.token).toLowerCase()} ${period} ${limit.limit}`
        })
        .sort()
        .join(', ')
}
