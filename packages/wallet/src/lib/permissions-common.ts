import {
    decodeAbiParameters,
    encodeAbiParameters,
    formatUnits,
    getAddress,
    isAddress,
    keccak256,
    parseAbiParameters,
    type Address,
    type Hex,
} from 'viem'
import {
    ANY_FUNCTION_SELECTOR as RELAYER_ANY_FUNCTION_SELECTOR,
    ANY_TARGET as RELAYER_ANY_TARGET,
    type PermissionInfo,
    type SpendPeriod,
} from '@nubl/relayer-client'
import { getUsdcTokenConfig, type ChainName } from './network-config'
import {
    normalizeSpendPeriod,
    parseSpendLimitDecimalUnits,
    toSpendPeriodEnum,
} from './session-common'

export const ANY_TARGET_ALIAS = 'any' as const

export const ANY_SELECTOR_ALIAS = 'any' as const

export const ANY_TARGET_ADDRESS = RELAYER_ANY_TARGET

export const ANY_SELECTOR = RELAYER_ANY_FUNCTION_SELECTOR

export const CALL_TAG = keccak256('0x74772e7065726d697373696f6e732e63616c6c2e7631')

export const SPEND_TAG = keccak256('0x74772e7065726d697373696f6e732e7370656e642e7631')

const PERIOD_VALUES: Record<SpendPeriod, number> = {
    minute: 0,
    hour: 1,
    day: 2,
    week: 3,
    month: 4,
    year: 5,
    forever: 6,
}

export type PermissionsErrorCode =
    | 'MISSING_ARGUMENT'
    | 'INVALID_KEY_SELECTOR'
    | 'KEY_NOT_FOUND'
    | 'RULE_PARSE_FAILED'
    | 'UNSUPPORTED_FOR_ADMIN_KEY'
    | 'KEYSTORE_NOT_FOUND'
    | 'PASSWORD_REQUIRED'
    | 'SIMULATION_FAILED'
    | 'SEND_FAILED'
    | 'PERMISSION_OP_UNVERIFIED'
    | 'UNKNOWN'

export class PermissionsError extends Error {
    code: PermissionsErrorCode
    cause?: unknown
    recoveryCommand?: string
    details?: unknown

    constructor(
        code: PermissionsErrorCode,
        message: string,
        options?: { cause?: unknown; recoveryCommand?: string; details?: unknown },
    ) {
        super(message)
        this.name = 'PermissionsError'
        this.code = code
        this.cause = options?.cause
        this.recoveryCommand = options?.recoveryCommand
        this.details = options?.details
    }
}

export type KeySelector = {
    positional?: string
    keyName?: string
    keyHash?: Hex
}

export type OnChainPermissionKey = {
    hash: Hex
    expiry: Hex
    type: 'secp256k1' | 'external' | 'p256'
    role: 'admin' | 'normal'
    publicKey: Hex
    permissions: PermissionInfo[]
}

export type LocalKeyMeta = {
    hash: Hex
    name: string
    address: Address
}

export function parseSelectorOrAny(value: string): Hex {
    if (value.toLowerCase() === ANY_SELECTOR_ALIAS) {
        return ANY_SELECTOR
    }

    const normalized = value.startsWith('0x') ? value : `0x${value}`

    if (!/^0x[a-fA-F0-9]{8}$/.test(normalized)) {
        throw new PermissionsError('RULE_PARSE_FAILED', `Invalid selector: ${value}`)
    }

    return normalized as Hex
}

export function parseAddressOrAny(value: string): Address {
    if (value.toLowerCase() === ANY_TARGET_ALIAS) {
        return ANY_TARGET_ADDRESS
    }

    if (!isAddress(value)) {
        throw new PermissionsError('RULE_PARSE_FAILED', `Invalid address: ${value}`)
    }

    return getAddress(value)
}

export function parseSpendLimitUnits(value: string): bigint {
    try {
        return parseSpendLimitDecimalUnits(value, {
            intendedUnits: 'token units',
            decimalsContext: 'v1',
        })
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : 'Spend limit must be a positive decimal number.'

        throw new PermissionsError('RULE_PARSE_FAILED', message)
    }
}

export function parsePeriod(value: string): SpendPeriod {
    try {
        return normalizeSpendPeriod(value)
    } catch {
        throw new PermissionsError('RULE_PARSE_FAILED', `Invalid period: ${value}`)
    }
}

export function parseKeyHash(value: string): Hex {
    const normalized = value.toLowerCase()

    if (!/^0x[a-f0-9]{64}$/.test(normalized)) {
        throw new PermissionsError('INVALID_KEY_SELECTOR', `Invalid key hash: ${value}`)
    }

    return normalized as Hex
}

export function isKeyHashRef(value: string): boolean {
    return /^0x[a-fA-F0-9]{64}$/.test(value)
}

export function normalizeAddressLower(value: Address): Address {
    return value.toLowerCase() as Address
}

export function normalizeHexLower(value: Hex): Hex {
    return value.toLowerCase() as Hex
}

export function callRuleId(target: Address, selector: Hex): string {
    return `call:${normalizeAddressLower(getAddress(target))}:${normalizeHexLower(selector)}`
}

export function spendRuleId(token: Address, period: SpendPeriod): string {
    return `spend:${normalizeAddressLower(getAddress(token))}:${period}`
}

export function callHashId(target: Address, selector: Hex): Hex {
    return keccak256(
        encodeAbiParameters(parseAbiParameters('bytes32,address,bytes4'), [
            CALL_TAG,
            getAddress(target),
            selector,
        ]),
    )
}

export function spendHashId(token: Address, period: SpendPeriod): Hex {
    return keccak256(
        encodeAbiParameters(parseAbiParameters('bytes32,address,uint8'), [
            SPEND_TAG,
            getAddress(token),
            PERIOD_VALUES[period],
        ]),
    )
}

export function parseRuleId(
    id: string,
):
    | { kind: 'call'; target: Address; selector: Hex }
    | { kind: 'spend'; token: Address; period: SpendPeriod } {
    const trimmed = id.trim()
    const parts = trimmed.split(':')

    if (parts.length !== 3) {
        throw new PermissionsError('RULE_PARSE_FAILED', `Invalid rule id: ${id}`)
    }

    const [kind, arg1, arg2] = parts

    if (!kind || !arg1 || !arg2) {
        throw new PermissionsError('RULE_PARSE_FAILED', `Invalid rule id: ${id}`)
    }

    if (kind === 'call') {
        return {
            kind,
            target: parseAddressOrAny(arg1),
            selector: parseSelectorOrAny(arg2),
        }
    }

    if (kind === 'spend') {
        if (arg1.toLowerCase() === ANY_TARGET_ALIAS) {
            throw new PermissionsError(
                'RULE_PARSE_FAILED',
                `Invalid spend token in rule id: ${arg1}`,
            )
        }

        if (!isAddress(arg1)) {
            throw new PermissionsError(
                'RULE_PARSE_FAILED',
                `Invalid spend token in rule id: ${arg1}`,
            )
        }

        return {
            kind,
            token: getAddress(arg1),
            period: parsePeriod(arg2),
        }
    }

    throw new PermissionsError('RULE_PARSE_FAILED', `Invalid rule kind: ${kind}`)
}

export function periodToEnum(period: SpendPeriod): number {
    return toSpendPeriodEnum(period)
}

export function deriveKeyAddress(key: Pick<OnChainPermissionKey, 'type' | 'publicKey'>): Address {
    if (key.type === 'secp256k1') {
        const [address] = decodeAbiParameters(parseAbiParameters('address'), key.publicKey)

        return getAddress(address)
    }

    if (key.type === 'p256') {
        // x||y is not an address. Use the trailing 20 bytes of keccak256(publicKey) for display.
        return getAddress(`0x${keccak256(key.publicKey).slice(-40)}`)
    }

    const raw = key.publicKey.startsWith('0x') ? key.publicKey.slice(2) : key.publicKey

    if (raw.length < 40) {
        throw new PermissionsError('UNKNOWN', 'Invalid external key publicKey length')
    }

    return getAddress(`0x${raw.slice(0, 40)}`)
}

export function resolveLocalNameByHash(
    hash: Hex,
    localKeys: LocalKeyMeta[],
): LocalKeyMeta | undefined {
    const normalized = normalizeHexLower(hash)

    return localKeys.find((entry) => normalizeHexLower(entry.hash) === normalized)
}

export function resolveSelectedKey(args: {
    selector: KeySelector
    keys: OnChainPermissionKey[]
    localKeys: LocalKeyMeta[]
}): { key: OnChainPermissionKey; local?: LocalKeyMeta } {
    const selector = args.selector
    const keys = args.keys

    const positional = selector.positional?.trim()

    const positionalHash =
        positional && isKeyHashRef(positional) ? parseKeyHash(positional) : undefined

    const explicitHash = selector.keyHash
    const explicitName = selector.keyName?.trim()

    const candidateHashes = new Set<string>()

    if (positionalHash) candidateHashes.add(normalizeHexLower(positionalHash))

    if (explicitHash) candidateHashes.add(normalizeHexLower(explicitHash))

    const positionalLocal =
        positional && !positionalHash
            ? args.localKeys.find((entry) => entry.name === positional)
            : undefined

    const explicitLocal = explicitName
        ? args.localKeys.find((entry) => entry.name === explicitName)
        : undefined

    if (positionalLocal) candidateHashes.add(normalizeHexLower(positionalLocal.hash))

    if (explicitLocal) candidateHashes.add(normalizeHexLower(explicitLocal.hash))

    if (candidateHashes.size > 1) {
        throw new PermissionsError(
            'INVALID_KEY_SELECTOR',
            'Key selector mismatch between positional and explicit selector values.',
        )
    }

    const selectedHash = [...candidateHashes][0]

    if (!selectedHash) {
        throw new PermissionsError(
            'MISSING_ARGUMENT',
            'Missing <key-ref>. Provide positional key ref or --key-name/--key-hash.',
        )
    }

    const key = keys.find((entry) => normalizeHexLower(entry.hash) === selectedHash)

    if (!key) {
        throw new PermissionsError('KEY_NOT_FOUND', `Key not found: ${selectedHash}`)
    }

    const local = resolveLocalNameByHash(key.hash, args.localKeys)

    return { key, local }
}

export function formatTokenAmount(input: {
    token: Address
    chain: ChainName
    raw: bigint
}): string {
    const usdc = getUsdcTokenConfig(input.chain).address

    if (normalizeAddressLower(input.token) === normalizeAddressLower(usdc)) {
        return formatUnits(input.raw, 6)
    }

    return input.raw.toString()
}

export function selectorLabel(selector: Hex): string | undefined {
    const normalized = normalizeHexLower(selector)

    if (normalized === '0xa9059cbb') return 'transfer(address,uint256)'

    if (normalized === '0x095ea7b3') return 'approve(address,uint256)'

    if (normalized === '0x23b872dd') return 'transferFrom(address,address,uint256)'

    if (normalized === ANY_SELECTOR) return 'ANY_SELECTOR'

    return undefined
}

export function tokenLabel(token: Address, chain: ChainName): string | undefined {
    const usdc = getUsdcTokenConfig(chain).address

    if (normalizeAddressLower(token) === normalizeAddressLower(usdc)) return 'USDC'

    return undefined
}
