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
/** Default `session create` USDC spend: 10 USDC per day. A higher limit is full access. */
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

/**
 * True when the requested permission is the same privilege as `--full-access`:
 * the flag itself, `ANY_TARGET`, the account, `ANY_FN_SEL`, an account-admin
 * selector, or a spend limit above the default 10 USDC.
 */
export function permissionNeedsFullAccessConfirmation(input: {
    fullAccess?: boolean
    target?: string
    selectors?: readonly string[]
    spendLimit?: bigint
    accountAddresses?: readonly string[]
}): boolean {
    if (input.fullAccess) return true
    if (input.spendLimit !== undefined && input.spendLimit > DEFAULT_SESSION_SPEND_LIMIT) {
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
        if (ACCOUNT_ADMIN_SELECTORS.has(normalized)) return true
    }

    return false
}
