import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    type Address,
    isAddress,
    getAddress,
    parseUnits,
    toFunctionSelector,
    zeroAddress,
    type Hex,
} from 'viem'
import {
    ANY_FUNCTION_SELECTOR as RELAYER_ANY_FUNCTION_SELECTOR,
    ANY_TARGET,
    ERC20_SELECTORS,
    computeKeyHash,
    encodeSecp256k1Key,
    type GetKeysResponse,
    type SpendPeriod,
} from '@nubl/relayer-client'
import { assertValidSessionName } from './keystore'
import { getUsdcTokenConfig, type ChainName } from './network-config'

export const ANY_FUNCTION_SELECTOR = RELAYER_ANY_FUNCTION_SELECTOR
/**
 * Default `session create` USDC spend: 10 USDC per day.
 * A higher limit, a period shorter than a day, or a non-USDC token is full access.
 */
export const DEFAULT_SESSION_SPEND_LIMIT = parseUnits('10', 6)
const MAX_UINT256 = 2n ** 256n - 1n

const ACCOUNT_ADMIN_SELECTORS = new Set(
    [
        'authorize((uint40,uint8,bool,bytes))',
        'revoke(bytes32)',
        'setCanExecute(bytes32,address,bytes4,bool)',
        'setSpendLimit(bytes32,address,uint8,uint256)',
        'upgradeProxyAccount(address)',
    ].map((signature) => toFunctionSelector(signature).toLowerCase()),
)
/** Allowance raise the guard does not revoke. Full access on any token, including USDC. */
const INCREASE_ALLOWANCE_SELECTOR = '0x39509351'
const AMBIGUOUS_BASE_UNIT_THRESHOLD = 1_000_000n

const DURATION_UNITS: Record<string, number> = {
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
}

export function parseDuration(value: string): number {
    const match = value.trim().match(/^(\d+)\s*([mhdw])$/)
    if (!match) {
        throw new Error(
            `Invalid duration "${value}". Use a number followed by m (minutes), h (hours), d (days), or w (weeks). Examples: 24h, 7d, 4w`,
        )
    }
    const amount = Number(match[1]!)
    if (amount <= 0) {
        throw new Error('Duration must be greater than zero.')
    }
    return amount * DURATION_UNITS[match[2]!]!
}

export function parseExpiry(value: string): number {
    const durationSeconds = parseDuration(value)
    return Math.floor(Date.now() / 1000) + durationSeconds
}

export type SpendLimitUnitLabels = {
    intendedUnits: string
    decimalsContext: string
}

export function resolveSessionDir(rootKeystorePath: string, sessionsDir: string): string {
    assertValidSessionName(sessionsDir)
    return join(dirname(rootKeystorePath), sessionsDir)
}

export async function listSessionNames(
    rootKeystorePath: string,
    sessionsDir: string,
): Promise<string[]> {
    const dir = resolveSessionDir(rootKeystorePath, sessionsDir)
    const entries = await readdir(dir, { withFileTypes: true })
    const names: string[] = []
    for (const entry of entries) {
        if (!entry.isFile()) continue
        if (!entry.name.endsWith('.json')) continue
        if (entry.name.startsWith('.rotation-')) continue
        const sessionName = entry.name.slice(0, -5)
        assertValidSessionName(sessionName)
        names.push(sessionName)
    }
    names.sort()
    return names
}

export function parseSessionName(value: string): string {
    const name = value.trim()
    assertValidSessionName(name)
    return name
}

export function parseTargetAddress(value: string): Address {
    if (!isAddress(value)) {
        throw new Error(`Invalid target address: ${value}`)
    }
    return getAddress(value)
}

export function parseSelector(value: string): Hex {
    const normalized = value.startsWith('0x') ? value : `0x${value}`
    if (!/^0x[a-fA-F0-9]{8}$/.test(normalized)) {
        throw new Error(`Invalid selector: ${value}`)
    }
    return normalized as Hex
}

export function parseSpendLimit(value: string): bigint {
    return parseSpendLimitDecimalUnits(value, {
        intendedUnits: 'USDC units',
        decimalsContext: 'USDC',
    })
}

export function parseSpendLimitDecimalUnits(value: string, labels: SpendLimitUnitLabels): bigint {
    const normalized = value.trim()
    if (!/^\d+(\.\d+)?$/.test(normalized)) {
        throw new Error('Spend limit must be a positive decimal number.')
    }
    if (!normalized.includes('.') && BigInt(normalized) >= AMBIGUOUS_BASE_UNIT_THRESHOLD) {
        throw new Error(
            `Spend limit ${normalized} looks like raw base units. Use --spend-limit-raw ${normalized} for base units, or include a decimal point if you intend ${labels.intendedUnits}.`,
        )
    }
    const fractional = normalized.split('.')[1] ?? ''
    if (fractional.length > 6) {
        throw new Error(
            `Spend limit supports at most 6 decimal places for ${labels.decimalsContext}.`,
        )
    }
    const amount = parseUnits(normalized, 6)
    if (amount <= 0n) {
        throw new Error('Spend limit must be greater than zero.')
    }
    return amount
}

export function toSpendPeriodEnum(period: SpendPeriod): number {
    switch (period) {
        case 'minute':
            return 0
        case 'hour':
            return 1
        case 'day':
            return 2
        case 'week':
            return 3
        case 'month':
            return 4
        case 'year':
            return 5
        case 'forever':
            return 6
        default:
            throw new Error(`Invalid spend period: ${period}`)
    }
}

export function normalizeSpendPeriod(value: string): SpendPeriod {
    if (
        value === 'minute' ||
        value === 'hour' ||
        value === 'day' ||
        value === 'week' ||
        value === 'month' ||
        value === 'year' ||
        value === 'forever'
    ) {
        return value
    }
    throw new Error(`Invalid spend period: ${value}`)
}

export function getChainKeys(keys: GetKeysResponse, chainId: number) {
    const direct = keys[`0x${chainId.toString(16)}`]
    if (Array.isArray(direct)) {
        return direct
    }

    for (const [hexChainId, entries] of Object.entries(keys)) {
        const parsed = Number.parseInt(hexChainId, 16)
        if (parsed === chainId && Array.isArray(entries)) {
            return entries
        }
    }

    return []
}

export function computeSessionKeyHash(sessionAddress: Address): Hex {
    return computeKeyHash('secp256k1', encodeSecp256k1Key(sessionAddress))
}

export function buildPermissionDefaults(input: {
    fullAccess: boolean
    chain: ChainName
    target?: Address
    selectors?: Hex[]
    spendLimit?: bigint
    spendPeriod?: SpendPeriod
}) {
    if (
        input.fullAccess &&
        (input.target !== undefined ||
            (input.selectors !== undefined && input.selectors.length > 0) ||
            input.spendLimit !== undefined ||
            input.spendPeriod !== undefined)
    ) {
        throw new Error(
            '--full-access cannot be combined with --target, --selector, --spend-limit, --spend-limit-raw, or --spend-period.',
        )
    }

    if (input.fullAccess) {
        return {
            target: ANY_TARGET,
            selectors: [ANY_FUNCTION_SELECTOR as Hex],
            spendToken: zeroAddress,
            spendLimit: MAX_UINT256,
            spendPeriod: 'forever' as SpendPeriod,
        }
    }

    const token = getUsdcTokenConfig(input.chain).address
    return {
        target: input.target ?? token,
        selectors:
            input.selectors && input.selectors.length > 0
                ? input.selectors
                : [ERC20_SELECTORS.TRANSFER],
        spendToken: token,
        spendLimit: input.spendLimit ?? DEFAULT_SESSION_SPEND_LIMIT,
        spendPeriod: input.spendPeriod ?? 'day',
    }
}

function normalizeAddress(value: string): string | undefined {
    const trimmed = value.trim()
    if (!isAddress(trimmed)) return undefined
    return getAddress(trimmed).toLowerCase()
}

function normalizeSelector(value: string): string | undefined {
    const trimmed = value.trim()
    const withPrefix = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed : `0x${trimmed}`
    if (!/^0x[a-fA-F0-9]{8}$/.test(withPrefix)) return undefined
    return withPrefix.toLowerCase()
}

function isChainUsdc(token: string, usdcAddress: string | undefined): boolean {
    if (!usdcAddress) return false
    const normalized = normalizeAddress(token)
    const usdc = normalizeAddress(usdcAddress)
    return normalized !== undefined && usdc !== undefined && normalized === usdc
}

/**
 * True when the requested permission is the same privilege as `--full-access`:
 * the flag itself, `ANY_TARGET`, the account, `ANY_FN_SEL`, an account-admin
 * selector, `increaseAllowance` on any token, a period shorter than a day, a
 * token other than the chain's USDC, or a spend that is not known to be at
 * most 10 USDC per day.
 *
 * A day-or-longer USDC bucket can be emptied in one day, so any USDC limit
 * above 10 is full access. Exactly 10 USDC on a day or longer period stays
 * allowed. `minute` and `hour` reset more than once a day, so they are full
 * access even when the amount is omitted or is exactly 10 USDC.
 */
export function permissionNeedsFullAccessConfirmation(input: {
    fullAccess?: boolean
    target?: string
    selectors?: readonly string[]
    spendLimit?: bigint
    spendPeriod?: SpendPeriod
    /** Session create/rotate install 10 USDC per day when amount and period are omitted. */
    defaultUsdcSpend?: boolean
    token?: string
    usdcAddress?: string
    accountAddresses?: readonly string[]
}): boolean {
    if (input.fullAccess) return true
    if (input.token !== undefined && !isChainUsdc(input.token, input.usdcAddress)) {
        return true
    }

    const period = input.spendPeriod ?? (input.defaultUsdcSpend ? 'day' : undefined)
    if (period === 'minute' || period === 'hour') {
        return true
    }

    const limit =
        input.spendLimit ?? (input.defaultUsdcSpend ? DEFAULT_SESSION_SPEND_LIMIT : undefined)
    if (limit !== undefined && limit > DEFAULT_SESSION_SPEND_LIMIT) {
        return true
    }
    if (period !== undefined && limit === undefined) {
        return true
    }

    const target = input.target ? normalizeAddress(input.target) : undefined
    if (target) {
        if (target === ANY_TARGET.toLowerCase()) return true
        for (const account of input.accountAddresses ?? []) {
            const normalized = normalizeAddress(account)
            if (normalized && normalized === target) return true
        }
    }

    for (const selector of input.selectors ?? []) {
        const normalized = normalizeSelector(selector)
        if (!normalized) continue
        if (normalized === ANY_FUNCTION_SELECTOR.toLowerCase()) return true
        if (normalized === INCREASE_ALLOWANCE_SELECTOR) return true
        if (ACCOUNT_ADMIN_SELECTORS.has(normalized)) return true
    }

    return false
}

/**
 * USDC spend normalized to a per-day figure.
 * Periods longer than a day, including forever, count at their full limit.
 */
export function normalizedDailyUsdcUnits(limit: bigint, period: SpendPeriod): bigint {
    if (period === 'minute') return limit * 1_440n
    if (period === 'hour') return limit * 24n
    return limit
}

function isSpendPeriod(value: string): value is SpendPeriod {
    return (
        value === 'minute' ||
        value === 'hour' ||
        value === 'day' ||
        value === 'week' ||
        value === 'month' ||
        value === 'year' ||
        value === 'forever'
    )
}

type StoredPermission = {
    type: string
    to?: string
    selector?: string
    token?: string
    limit?: string
    period?: string
}

/**
 * True when every call permission is in the narrow allowlist.
 * Spend permissions are judged separately. An empty call set fits.
 */
export function callPermissionsFitAllowlist(
    permissions: readonly StoredPermission[],
    allowedCalls: ReadonlySet<string>,
): boolean {
    for (const permission of permissions) {
        if (permission.type !== 'call') continue
        const target = permission.to ? normalizeAddress(permission.to) : undefined
        const selector = permission.selector ? normalizeSelector(permission.selector) : undefined
        if (!target || !selector) return false
        if (!allowedCalls.has(`${target}:${selector}`)) return false
    }
    return true
}

/**
 * True when stored permissions are above the full-access gate, their
 * combined USDC spend is above 10 USDC per day, or the list is empty.
 * A narrow verdict needs a positive allowlist match from chain, not an empty read.
 */
export function storedPermissionsRequirePhrase(
    permissions: readonly StoredPermission[],
    usdcAddress: string | undefined,
): boolean {
    if (permissions.length === 0) return true
    let daily = 0n
    let sawUsdcSpend = false
    for (const permission of permissions) {
        if (permission.type === 'call') {
            if (
                permissionNeedsFullAccessConfirmation({
                    target: permission.to,
                    selectors: permission.selector ? [permission.selector] : undefined,
                    usdcAddress,
                })
            ) {
                return true
            }
            continue
        }
        if (permission.type !== 'spend') return true
        if (!permission.period || !isSpendPeriod(permission.period)) return true
        let limit: bigint
        try {
            if (permission.limit === undefined || permission.limit === '') return true
            limit = BigInt(permission.limit)
        } catch {
            return true
        }
        if (
            permissionNeedsFullAccessConfirmation({
                token: permission.token,
                spendLimit: limit,
                spendPeriod: permission.period,
                usdcAddress,
            })
        ) {
            return true
        }
        if (permission.token && isChainUsdc(permission.token, usdcAddress)) {
            sawUsdcSpend = true
            daily += normalizedDailyUsdcUnits(limit, permission.period)
        }
    }
    // A call list with no USDC spend limit is elevated. The spend guard does not
    // count every selector those calls can use.
    if (!sawUsdcSpend) return true
    return daily > DEFAULT_SESSION_SPEND_LIMIT
}

export function callsIncludeWildcard(permissions: readonly StoredPermission[]): boolean {
    for (const permission of permissions) {
        if (permission.type !== 'call') continue
        const target = permission.to ? normalizeAddress(permission.to) : undefined
        const selector = permission.selector ? normalizeSelector(permission.selector) : undefined
        if (target === ANY_TARGET.toLowerCase()) return true
        if (selector === ANY_FUNCTION_SELECTOR.toLowerCase()) return true
    }
    return false
}

type ChainKeyLike = {
    hash?: string
    expiry?: string
    permissions?: readonly StoredPermission[]
}

/**
 * Sum of active keys' USDC spend, normalized per day.
 * `unreadable` when a USDC spend limit or an active key's expiry cannot be parsed.
 */
export function activeUsdcDailyTotal(
    keys: readonly ChainKeyLike[],
    usdcAddress: string | undefined,
    excludeHash?: string,
): bigint | 'unreadable' {
    if (!usdcAddress) return 'unreadable'
    let total = 0n
    const now = BigInt(Math.floor(Date.now() / 1000))
    for (const key of keys) {
        if (
            excludeHash &&
            key.hash &&
            key.hash.toLowerCase() === excludeHash.toLowerCase()
        ) {
            continue
        }
        if (key.expiry === undefined || key.permissions === undefined) return 'unreadable'
        let expiry: bigint
        try {
            expiry = BigInt(key.expiry)
        } catch {
            return 'unreadable'
        }
        if (expiry !== 0n && expiry <= now) continue
        for (const permission of key.permissions) {
            if (permission.type !== 'spend') continue
            if (!permission.token || !isChainUsdc(permission.token, usdcAddress)) continue
            if (!permission.period || !isSpendPeriod(permission.period)) return 'unreadable'
            let limit: bigint
            try {
                if (permission.limit === undefined || permission.limit === '') return 'unreadable'
                limit = BigInt(permission.limit)
            } catch {
                return 'unreadable'
            }
            total += normalizedDailyUsdcUnits(limit, permission.period)
        }
    }
    return total
}
