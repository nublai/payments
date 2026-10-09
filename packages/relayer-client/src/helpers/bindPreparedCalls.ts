import { getAddress, zeroAddress, type Address, type Hex } from 'viem'
import { hashTypedData } from 'viem/utils'
import type { PrepareCallsResponse } from '../actions/prepareCalls'
import { INTENT_TYPES, type Call } from '../types'

export const ORCHESTRATOR_DOMAIN_NAME = 'Orchestrator'

export const ORCHESTRATOR_DOMAIN_VERSION = '0.5.5'

/** Wallet TTL for an intent expiry. The relayer does not choose this. */
export const INTENT_EXPIRY_TTL_SECONDS = 3600n

/**
 * Margin added to the accepted quote before it becomes paymentMaxAmount.
 * paymentAmount and paymentRecipient are not in the Intent typehash, so this
 * margin is the most a filler can add. 5% covers a modest base-fee move
 * between quote and inclusion. The 0.001 USDC floor (6 decimals) keeps a
 * 1-unit quote from rounding the percent to zero while still bounding the
 * filler far under the 5 USDC ceiling.
 */
export const FEE_CAP_MARGIN_BPS = 500n

export const FEE_CAP_MARGIN_FLOOR = 1_000n

export class PreparedCallsBindingError extends Error {
    readonly code = 'PREPARED_CALLS_MISMATCH' as const

    constructor(message: string) {
        super(message)
        this.name = 'PreparedCallsBindingError'
    }
}

/** Off-local hard ceiling. A caller cap above this is clamped down to it. */
export const PAID_FEE_CAP = 5_000_000n

/**
 * Circle native USDC. The 5 USDC ceiling is this token's 6-decimal units.
 * USDC.e, WBTC, and native ETH are not this token.
 * Keep in step with wallet `getUsdcAddressByChainId`.
 */
const NATIVE_USDC_BY_CHAIN_ID: Record<number, Address> = {
    8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
}

export class PaymentCapError extends Error {
    readonly code: 'PAYMENT_CAP_INCOMPLETE' | 'PAYMENT_FEE_REFUSED'

    constructor(
        message: string,
        code: 'PAYMENT_CAP_INCOMPLETE' | 'PAYMENT_FEE_REFUSED' = 'PAYMENT_CAP_INCOMPLETE',
    ) {
        super(message)
        this.name = 'PaymentCapError'
        this.code = code
    }
}

export function requirePayerAndToken(payer: Address | undefined, paymentToken: Address | undefined): void {
    if (payer === undefined || paymentToken === undefined) {
        throw new PaymentCapError(
            'Refusing to sign prepared calls: paymentMaxAmount requires payer and paymentToken',
        )
    }
}

/** A lone payer or token must not override the policy while the cap is omitted. */
export function refuseLonePayerOrToken(
    payer: Address | undefined,
    paymentToken: Address | undefined,
    paymentMaxAmount: bigint | undefined,
): void {
    const hasPayer = payer !== undefined
    const hasToken = paymentToken !== undefined

    if (hasPayer !== hasToken && paymentMaxAmount === undefined) {
        throw new PaymentCapError(
            'Refusing to sign prepared calls: payer and paymentToken must be passed together',
        )
    }
}

/** Off local, the fee token is that chain's native USDC and the payer is not native ETH. */
export function assertOffLocalFeeToken(chainId: number, payer: Address, paymentToken: Address): void {
    if (getAddress(payer) === zeroAddress || getAddress(paymentToken) === zeroAddress) {
        throw new PaymentCapError(
            'Refusing to sign prepared calls: payer and paymentToken must not be the zero address off local chains',
            'PAYMENT_FEE_REFUSED',
        )
    }

    const usdc = NATIVE_USDC_BY_CHAIN_ID[chainId]

    if (!usdc || getAddress(paymentToken) !== getAddress(usdc)) {
        throw new PaymentCapError(
            `Refusing to sign prepared calls: paymentToken must be native USDC on chain ${chainId}`,
            'PAYMENT_FEE_REFUSED',
        )
    }
}

/** Use the caller cap when it is tighter than the policy ceiling. Never above it. */
export function clampPaymentCeiling(requested: bigint, policyCeiling: bigint): bigint {
    if (requested < 0n) {
        throw new PaymentCapError('Refusing to sign prepared calls: paymentMaxAmount is negative')
    }

    return requested > policyCeiling ? policyCeiling : requested
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
    /**
     * Hard ceiling. A quote, or quote plus margin, above this is refused.
     * The signed cap itself is the quote plus margin, not this ceiling.
     */
    paymentCeiling?: bigint
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

export function feeCapMargin(paymentAmount: bigint): bigint {
    if (paymentAmount <= 0n) return 0n
    const percent = (paymentAmount * FEE_CAP_MARGIN_BPS + 9_999n) / 10_000n

    return percent > FEE_CAP_MARGIN_FLOOR ? percent : FEE_CAP_MARGIN_FLOOR
}

/** Signed paymentMaxAmount for an accepted quote. Zero quotes stay at cap 0. */
export function signedPaymentMaxForQuote(paymentAmount: bigint): bigint {
    return paymentAmount + feeCapMargin(paymentAmount)
}

export function parseQuotePaymentAmount(
    value: unknown,
): { ok: true; amount: bigint } | { ok: false; reason: 'missing' | 'invalid' } {
    if (value === undefined || value === null || value === '') return { ok: false, reason: 'missing' }

    try {
        if (typeof value === 'bigint') {
            return value < 0n ? { ok: false, reason: 'invalid' } : { ok: true, amount: value }
        }

        if (typeof value === 'number' && Number.isInteger(value)) {
            return value < 0 ? { ok: false, reason: 'invalid' } : { ok: true, amount: BigInt(value) }
        }

        if (typeof value === 'string' && value.trim() !== '') {
            const text = value.trim()

            if (text.startsWith('-')) return { ok: false, reason: 'invalid' }

            return { ok: true, amount: BigInt(text) }
        }
    } catch {
        return { ok: false, reason: 'invalid' }
    }

    return { ok: false, reason: 'invalid' }
}

export function firstQuotePaymentAmount(prepared: {
    context?: { quote?: { quotes?: Array<{ paymentAmount?: unknown }> } }
}): bigint | undefined {
    const parsed = parseQuotePaymentAmount(prepared.context?.quote?.quotes?.[0]?.paymentAmount)

    if (parsed.ok) return parsed.amount

    if (parsed.reason === 'missing') return undefined

    refuse('quote payment amount is not numeric')
}

/**
 * Cap the signature will authorize. Off local, a zero, missing, or non-numeric
 * quote is refused so it cannot fall back to the 5 USDC ceiling. Local zero-fee
 * quotes sign cap 0.
 */
export function resolveSignedFeeCap(input: {
    paymentAmount: unknown
    ceiling: bigint
    zeroFee: boolean
}): bigint {
    const parsed = parseQuotePaymentAmount(input.paymentAmount)

    if (!parsed.ok) {
        refuse(
            parsed.reason === 'missing'
                ? 'quote payment amount is missing'
                : 'quote payment amount is not numeric',
        )
    }

    if (parsed.amount === 0n) {
        if (!input.zeroFee) refuse('off-local quote payment is zero')

        return 0n
    }

    const cap = signedPaymentMaxForQuote(parsed.amount)

    if (parsed.amount > input.ceiling || cap > input.ceiling) refuse('payment amount exceeds fee cap')

    return cap
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

    return actual.every((item, index) => item.toLowerCase() === expected[index]?.toLowerCase())
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
        actual.every((field, index) => field.name === expected[index]?.name && field.type === expected[index]?.type)

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

    for (const [index, got] of actual.entries()) {
        const wanted = expectedCalls[index]

        if (wanted === undefined) refuse('call count does not match')
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

        const parsedPayment = parseQuotePaymentAmount(
            (quote as { paymentAmount?: unknown }).paymentAmount,
        )

        if (!parsedPayment.ok) {
            refuse(
                parsedPayment.reason === 'missing'
                    ? 'quote payment amount is missing'
                    : 'quote payment amount is not numeric',
            )
        }

        const paymentAmount = parsedPayment.amount
        const requiredCap = signedPaymentMaxForQuote(paymentAmount)

        if (
            expected.paymentCeiling !== undefined &&
            (paymentAmount > expected.paymentCeiling || requiredCap > expected.paymentCeiling)
        ) {
            refuse('payment amount exceeds fee cap')
        }

        if (canonical.paymentMaxAmount !== requiredCap) {
            refuse(
                paymentAmount > canonical.paymentMaxAmount
                    ? 'payment amount exceeds fee cap'
                    : 'fee cap does not match the quote',
            )
        }
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
