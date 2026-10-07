import { getAddress, zeroAddress, type Address, type Hex } from 'viem'
import { hashTypedData } from 'viem/utils'
import type { PrepareCallsResponse } from '../actions/prepareCalls'
import { INTENT_TYPES, type Call } from '../types'

export const ORCHESTRATOR_DOMAIN_NAME = 'Orchestrator'
export const ORCHESTRATOR_DOMAIN_VERSION = '0.5.5'
/** Wallet TTL for an intent expiry. The relayer does not choose this. */
export const INTENT_EXPIRY_TTL_SECONDS = 3600n

export class PreparedCallsBindingError extends Error {
    readonly code = 'PREPARED_CALLS_MISMATCH' as const

    constructor(message: string) {
        super(message)
        this.name = 'PreparedCallsBindingError'
    }
}

export type PreparedCallsExpectation = {
    from: Address
    calls: readonly Call[]
    chainId: number
    verifyingContract: Address
    nonce: bigint
    /** Unix seconds. Required. Never taken from the relayer typed data. */
    expiry: bigint
    /**
     * Maximum combinedGas the wallet will sign. The relayer value is accepted
     * only when it is within this ceiling. The ceiling is not read from typed data.
     */
    combinedGasCeiling: bigint
    /** Unix seconds used for expiry bounds. Defaults to the current time. */
    now?: bigint
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: bigint
    settler?: Address
    settlerContext?: Hex
    encodedPreCalls?: readonly Hex[]
    encodedFundTransfers?: readonly Hex[]
}

type NormalizedCall = { to: Address; value: bigint; data: Hex }

type NormalizedIntent = {
    multichain: boolean
    eoa: Address
    calls: NormalizedCall[]
    nonce: bigint
    payer: Address
    paymentToken: Address
    paymentMaxAmount: bigint
    combinedGas: bigint
    encodedPreCalls: Hex[]
    encodedFundTransfers: Hex[]
    settler: Address
    expiry: bigint
}

function refuse(detail: string): never {
    throw new PreparedCallsBindingError(`Refusing to sign prepared calls: ${detail}`)
}

function readUint(value: unknown, label: string): bigint {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
    if (typeof value === 'string' && value.trim() !== '') {
        try {
            return BigInt(value.trim())
        } catch {
            refuse(`invalid ${label}`)
        }
    }
    refuse(`missing ${label}`)
}

function readAddress(value: unknown, label: string): Address {
    if (typeof value !== 'string') refuse(`missing ${label}`)
    try {
        return getAddress(value)
    } catch {
        refuse(`invalid ${label}`)
    }
}

function readHex(value: unknown, label: string): Hex {
    if (typeof value !== 'string' || !value.startsWith('0x')) refuse(`invalid ${label}`)
    return value.toLowerCase() as Hex
}

function readHexList(value: unknown, label: string): Hex[] {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) refuse(`invalid ${label}`)
    return value.map((item, index) => readHex(item, `${label}[${index}]`))
}

function sameHexList(actual: readonly Hex[], expected: readonly Hex[]): boolean {
    if (actual.length !== expected.length) return false
    return actual.every((item, index) => item.toLowerCase() === expected[index].toLowerCase())
}

function readCalls(value: unknown, label: string): NormalizedCall[] {
    if (!Array.isArray(value)) refuse(`missing ${label}`)
    return value.map((item, index) => {
        if (item === null || typeof item !== 'object') refuse(`invalid ${label}[${index}]`)
        const call = item as Record<string, unknown>
        return {
            to: readAddress(call.to, `${label}[${index}].to`),
            value: readUint(call.value, `${label}[${index}].value`),
            data: readHex(call.data ?? '0x', `${label}[${index}].data`),
        }
    })
}

function typesMatch(types: PrepareCallsResponse['typedData']['types']): boolean {
    const sameFields = (
        actual: ReadonlyArray<{ name: string; type: string }> | undefined,
        expected: ReadonlyArray<{ name: string; type: string }>,
    ) =>
        !!actual &&
        actual.length === expected.length &&
        actual.every((field, index) => field.name === expected[index].name && field.type === expected[index].type)

    return sameFields(types?.Intent, INTENT_TYPES.Intent) && sameFields(types?.Call, INTENT_TYPES.Call)
}

function parseTypedIntent(prepared: PrepareCallsResponse): NormalizedIntent {
    const message = prepared.typedData?.message as unknown
    if (message === null || typeof message !== 'object') refuse('typed data message is missing')
    const record = message as Record<string, unknown>
    if (prepared.typedData.primaryType !== 'Intent') refuse('typed data primary type does not match')
    if (!typesMatch(prepared.typedData.types)) refuse('typed data types do not match')
    return {
        multichain: record.multichain === true,
        eoa: readAddress(record.eoa, 'typed data eoa'),
        calls: readCalls(record.calls, 'typed data calls'),
        nonce: readUint(record.nonce, 'typed data nonce'),
        payer: readAddress(record.payer, 'typed data payer'),
        paymentToken: readAddress(record.paymentToken, 'typed data payment token'),
        paymentMaxAmount: readUint(record.paymentMaxAmount, 'typed data fee cap'),
        combinedGas: readUint(record.combinedGas, 'typed data combined gas'),
        encodedPreCalls: readHexList(record.encodedPreCalls, 'typed data precalls'),
        encodedFundTransfers: readHexList(record.encodedFundTransfers, 'typed data fund transfers'),
        settler: readAddress(record.settler, 'typed data settler'),
        expiry: readUint(record.expiry, 'typed data expiry'),
    }
}

function optionalAddress(value: unknown, fallback: Address): Address {
    if (value === undefined || value === null || value === '') return fallback
    return readAddress(value, 'quote address')
}

function parseQuoteIntent(intent: unknown): NormalizedIntent & { settlerContext: Hex } {
    if (intent === null || typeof intent !== 'object') refuse('quote does not match the signed intent')
    const record = intent as Record<string, unknown>
    return {
        multichain: false,
        eoa: readAddress(record.eoa, 'quote eoa'),
        calls: readCalls(record.calls, 'quote calls'),
        nonce: readUint(record.nonce, 'quote nonce'),
        payer: optionalAddress(record.payer, zeroAddress),
        paymentToken: optionalAddress(record.paymentToken, zeroAddress),
        paymentMaxAmount:
            record.paymentMaxAmount === undefined || record.paymentMaxAmount === null
                ? 0n
                : readUint(record.paymentMaxAmount, 'quote fee cap'),
        combinedGas: readUint(record.combinedGas, 'quote combined gas'),
        encodedPreCalls: readHexList(record.encodedPreCalls, 'quote precalls'),
        encodedFundTransfers: readHexList(record.encodedFundTransfers, 'quote fund transfers'),
        settler: optionalAddress(record.settler, zeroAddress),
        expiry: readUint(record.expiry, 'quote expiry'),
        settlerContext: record.settlerContext ? readHex(record.settlerContext, 'quote settler context') : '0x',
    }
}

function assertCallsMatch(
    actual: readonly NormalizedCall[],
    expectedCalls: readonly Call[],
    source: 'typed data' | 'quote',
): void {
    if (actual.length !== expectedCalls.length) {
        refuse(source === 'quote' ? 'quote does not match the signed intent' : 'call count does not match')
    }
    for (let index = 0; index < actual.length; index++) {
        const wanted = expectedCalls[index]
        const got = actual[index]
        const targetMatches = got.to === getAddress(wanted.target)
        const valueMatches = got.value === wanted.value
        const dataMatches = got.data === (wanted.data ?? '0x').toLowerCase()
        if (targetMatches && valueMatches && dataMatches) continue
        if (source === 'quote') refuse('quote does not match the signed intent')
        if (!targetMatches) refuse(`call target does not match (call ${index})`)
        if (!valueMatches) refuse(`call value does not match (call ${index})`)
        refuse(`call data does not match (call ${index})`)
    }
}

function assertIntentMatches(actual: NormalizedIntent, expected: NormalizedIntent, label: string): void {
    const source = label === 'quote' ? 'quote' : 'typed data'
    if (source === 'quote' && actual.eoa !== expected.eoa) refuse('quote does not match the signed intent')
    if (actual.multichain !== expected.multichain) {
        refuse(source === 'quote' ? 'quote does not match the signed intent' : 'multichain flag does not match')
    }
    if (actual.eoa !== expected.eoa) refuse('account does not match')
    assertCallsMatch(
        actual.calls,
        expected.calls.map((call) => ({ target: call.to, value: call.value, data: call.data })),
        source,
    )
    if (label === 'quote') {
        if (
            actual.nonce !== expected.nonce ||
            actual.payer !== expected.payer ||
            actual.paymentToken !== expected.paymentToken ||
            actual.paymentMaxAmount !== expected.paymentMaxAmount ||
            actual.combinedGas !== expected.combinedGas ||
            actual.expiry !== expected.expiry ||
            actual.settler !== expected.settler ||
            !sameHexList(actual.encodedPreCalls, expected.encodedPreCalls) ||
            !sameHexList(actual.encodedFundTransfers, expected.encodedFundTransfers)
        ) {
            refuse('quote does not match the signed intent')
        }
        return
    }
    if (actual.nonce !== expected.nonce) refuse('nonce does not match')
    if (actual.payer !== expected.payer) refuse('fee payer does not match')
    if (actual.paymentToken !== expected.paymentToken) refuse('fee token does not match')
    if (actual.paymentMaxAmount !== expected.paymentMaxAmount) refuse('fee cap does not match')
    if (actual.combinedGas !== expected.combinedGas) refuse('combined gas does not match')
    if (actual.expiry !== expected.expiry) refuse('expiry does not match')
    if (actual.settler !== expected.settler) refuse('settler does not match')
    if (!sameHexList(actual.encodedPreCalls, expected.encodedPreCalls)) refuse('precalls do not match')
    if (!sameHexList(actual.encodedFundTransfers, expected.encodedFundTransfers)) {
        refuse('fund transfers do not match')
    }
}

export type BoundPreparedCalls = {
    digest: Hex
    /** Typed data the caller must sign. Domain has no salt or extra fields. */
    typedData: PrepareCallsResponse['typedData']
}

/**
 * Recompute the Orchestrator EIP-712 digest from the calls the caller asked for.
 * Throws unless the relayer typed data, digest, and executed quote all match.
 * Returns the typed data to sign. Callers must sign that object, not the relayer's.
 */
export function bindPreparedCalls(
    prepared: PrepareCallsResponse,
    expected: PreparedCallsExpectation,
): BoundPreparedCalls {
    if (!expected?.from || !expected.calls || expected.chainId === undefined || !expected.verifyingContract) {
        refuse('expected account, calls, chain, and verifying contract are required')
    }
    if (expected.nonce === undefined) refuse('nonce is required')
    if (expected.expiry === undefined) refuse('expiry is required')
    if (expected.combinedGasCeiling === undefined) refuse('combined gas ceiling is required')

    const now = expected.now ?? BigInt(Math.floor(Date.now() / 1000))
    if (expected.expiry === 0n) refuse('expiry is unset')
    if (expected.expiry <= now) refuse('expiry is in the past')
    if (expected.expiry > now + INTENT_EXPIRY_TTL_SECONDS) refuse('expiry exceeds the wallet ttl')

    const domain = prepared.typedData?.domain
    if (!domain) refuse('typed data domain is missing')
    if (domain.name !== ORCHESTRATOR_DOMAIN_NAME || domain.version !== ORCHESTRATOR_DOMAIN_VERSION) {
        refuse('domain name or version does not match')
    }
    if (Number(domain.chainId) !== expected.chainId) refuse('chain id does not match')
    if (readAddress(domain.verifyingContract, 'verifying contract') !== getAddress(expected.verifyingContract)) {
        refuse('verifying contract does not match')
    }

    const typed = parseTypedIntent(prepared)
    if (typed.combinedGas <= 0n) refuse('combined gas is unset')
    if (typed.combinedGas > expected.combinedGasCeiling) refuse('combined gas exceeds the wallet ceiling')

    const canonical: NormalizedIntent = {
        multichain: false,
        eoa: getAddress(expected.from),
        calls: expected.calls.map((call) => ({
            to: getAddress(call.target),
            value: call.value,
            data: (call.data ?? '0x').toLowerCase() as Hex,
        })),
        nonce: expected.nonce,
        payer: getAddress(expected.payer ?? zeroAddress),
        paymentToken: getAddress(expected.paymentToken ?? zeroAddress),
        paymentMaxAmount: expected.paymentMaxAmount ?? 0n,
        combinedGas: typed.combinedGas,
        encodedPreCalls: (expected.encodedPreCalls ?? []).map((item) => item.toLowerCase() as Hex),
        encodedFundTransfers: (expected.encodedFundTransfers ?? []).map((item) => item.toLowerCase() as Hex),
        settler: getAddress(expected.settler ?? zeroAddress),
        expiry: expected.expiry,
    }

    assertIntentMatches(typed, canonical, 'typed data')

    const quotes = prepared.context?.quote?.quotes
    if (!Array.isArray(quotes) || quotes.length === 0) refuse('quote does not match the signed intent')
    const expectedSettlerContext = (expected.settlerContext ?? '0x').toLowerCase()
    for (const quote of quotes) {
        if (Number(readUint(quote.chainId, 'quote chain id')) !== expected.chainId) {
            refuse('chain id does not match')
        }
        if (readAddress(quote.orchestrator, 'quote orchestrator') !== getAddress(expected.verifyingContract)) {
            refuse('verifying contract does not match')
        }
        const quoteIntent = parseQuoteIntent(quote.intent)
        assertIntentMatches(quoteIntent, canonical, 'quote')
        if (quoteIntent.settlerContext !== expectedSettlerContext) {
            refuse('quote does not match the signed intent')
        }
        const quotedPayment = (quote as { paymentAmount?: unknown }).paymentAmount
        const paymentAmount =
            quotedPayment === undefined || quotedPayment === null
                ? 0n
                : readUint(quotedPayment, 'quote payment amount')
        if (paymentAmount > canonical.paymentMaxAmount) refuse('payment amount exceeds fee cap')
    }

    const signingDomain = {
        name: ORCHESTRATOR_DOMAIN_NAME,
        version: ORCHESTRATOR_DOMAIN_VERSION,
        chainId: expected.chainId,
        verifyingContract: getAddress(expected.verifyingContract),
    }
    const typedData: PrepareCallsResponse['typedData'] = {
        domain: signingDomain,
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message: canonical,
    }
    const digest = hashTypedData({
        domain: signingDomain,
        types: INTENT_TYPES,
        primaryType: 'Intent',
        message: canonical,
    })
    if (typeof prepared.digest !== 'string' || prepared.digest.toLowerCase() !== digest.toLowerCase()) {
        refuse('digest does not match')
    }
    return { digest, typedData }
}
