import { decodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import { getAddressesWithFallback } from '@nubl/contracts/deployments'
import { INTENT_TYPES } from '@nubl/relayer-client'
import { DEFAULT_SESSION_SPEND_LIMIT } from './session-common'
import { narrowCallAllowlist } from './session-chain-permissions'
import {
    chainsForEnv,
    getChainConfig,
    getChainNameByChainId,
    getUsdcTokenConfig,
    type EnvName,
} from './network-config'
import { PAID_FEE_CAP, QuotePaymentRejected, reviewQuotePayment } from './intent-payment'
import { RelayQuoteRejected, relayEntryPoints, reviewRelayIntentCalls } from './relay-allowlist'
import { isRecord } from './type-guards'

export const ORCHESTRATOR_DOMAIN_NAME = 'Orchestrator'

export const ORCHESTRATOR_DOMAIN_VERSION = '0.5.5'

const erc20Abi = parseAbi([
    'function transfer(address to, uint256 amount)',
    'function approve(address spender, uint256 amount)',
])

const escrowAbi = parseAbi([
    'function escrow((bytes12 salt, address depositor, address recipient, address token, uint256 escrowAmount, uint256 refundAmount, uint256 refundTimestamp, address settler, address sender, bytes32 settlementId, uint256 senderChainId)[] escrows)',
    'function refund(bytes32[] escrowIds)',
    'function settle(bytes32[] escrowIds)',
])

const settlerAbi = parseAbi([
    'function write(address sender, bytes32 settlementId, uint256 chainId, bytes signature)',
])

export class PhraseLessSignError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PhraseLessSignError'
    }
}

function fail(message: string): never {
    throw new PhraseLessSignError(message)
}

export type SwapSignRefusalCode = 'MULTICHAIN_INTENT' | 'PRE_CALLS' | 'FUNDS_OUT' | 'SETTLER_CALL'

export class SwapSignRefused extends Error {
    readonly code: SwapSignRefusalCode

    constructor(code: SwapSignRefusalCode, message: string) {
        super(message)
        this.name = 'SwapSignRefused'
        this.code = code
    }
}

function refuse(code: SwapSignRefusalCode, message: string): never {
    throw new SwapSignRefused(code, message)
}

function asBigint(value: unknown, label: string): bigint {
    if (typeof value === 'bigint') return value

    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))

    if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
    fail(`Phrase-less session refused an Orchestrator intent with an unreadable ${label}`)
}

function asAddress(value: unknown, label: string): Address {
    if (typeof value !== 'string') {
        fail(`Phrase-less session refused an Orchestrator intent with an unreadable ${label}`)
    }

    try {
        return getAddress(value)
    } catch {
        fail(`Phrase-less session refused an Orchestrator intent with an unreadable ${label}`)
    }
}

function asHex(value: unknown, label: string): Hex {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
        fail(`Phrase-less session refused an Orchestrator intent with an unreadable ${label}`)
    }

    return value as Hex
}

export function typesMatch(
    types: unknown,
): types is { Intent: typeof INTENT_TYPES.Intent; Call: typeof INTENT_TYPES.Call } {
    if (!isRecord(types)) return false

    return (
        JSON.stringify(types.Intent) === JSON.stringify(INTENT_TYPES.Intent) &&
        JSON.stringify(types.Call) === JSON.stringify(INTENT_TYPES.Call)
    )
}

function selectorOf(data: Hex): string {
    return data.length >= 10 ? data.slice(0, 10).toLowerCase() : '0x'
}

/**
 * USDC a narrow call moves or approves. Escrow pulls are the escrow amounts
 * when the calldata decodes; anything else that is not a plain narrow call is refused.
 */
function usdcMovedByCall(input: {
    to: Address
    value: bigint
    data: Hex
    usdc: Address
    allowed: ReadonlySet<string>
}): bigint {
    if (input.value !== 0n) {
        fail('Phrase-less session refused a call that sends native value')
    }

    const selector = selectorOf(input.data)
    const key = `${input.to.toLowerCase()}:${selector}`

    if (!input.allowed.has(key)) {
        fail(
            `Phrase-less session refused a call outside the narrow set (${input.to} ${selector})`,
        )
    }

    const usdc = input.usdc.toLowerCase()

    if (input.to.toLowerCase() === usdc && selector === '0xa9059cbb') {
        const decoded = decodeFunctionData({ abi: erc20Abi, data: input.data })

        return decoded.args[1]
    }

    if (input.to.toLowerCase() === usdc && selector === '0x095ea7b3') {
        const decoded = decodeFunctionData({ abi: erc20Abi, data: input.data })

        return decoded.args[1]
    }

    if (selector === '0x657061bf') {
        let decoded: ReturnType<typeof decodeFunctionData<typeof escrowAbi>>

        try {
            decoded = decodeFunctionData({ abi: escrowAbi, data: input.data })
        } catch {
            fail('Phrase-less session refused an escrow call whose pull amount could not be read')
        }

        if (decoded.functionName !== 'escrow') {
            fail('Phrase-less session refused an escrow call whose pull amount could not be read')
        }

        let total = 0n
        const rows = decoded.args[0]

        for (const row of rows) {
            const amount = row.escrowAmount

            if (amount === 0n) continue

            if (getAddress(row.token).toLowerCase() !== usdc) {
                fail('Phrase-less session refused an escrow pull of a non-USDC token')
            }

            total += amount
        }

        return total
    }

    if (selector === '0x6023fda5' || selector === '0xe7f921a2') {
        try {
            decodeFunctionData({ abi: escrowAbi, data: input.data })
        } catch {
            fail('Phrase-less session refused an escrow call with unreadable calldata')
        }

        return 0n
    }

    if (selector === '0x84523a30') {
        try {
            decodeFunctionData({ abi: settlerAbi, data: input.data })
        } catch {
            fail('Phrase-less session refused a settler write with unreadable calldata')
        }

        return 0n
    }

    fail(`Phrase-less session refused a call outside the narrow set (${input.to} ${selector})`)
}

export type PhraseLessIntentDecision = {
    chainId: number
    usdc: bigint
}

/**
 * Phrase-less sessions may sign only an Orchestrator 0.5.5 intent whose calls
 * stay inside the narrow set, and only up to the 10 USDC/day budget.
 * `calls` is the EIP-712 form of the intent's executionData.
 */
export function assessPhraseLessIntent(input: {
    typedData: unknown
    env: EnvName | undefined
}): PhraseLessIntentDecision {
    if (!input.env) {
        fail('Phrase-less session cannot sign because unlock did not record an environment')
    }

    if (!isRecord(input.typedData)) {
        fail('Phrase-less sessions can only sign Orchestrator intents')
    }

    const domain = input.typedData.domain

    if (!isRecord(domain)) {
        fail('Phrase-less sessions can only sign Orchestrator intents')
    }

    if (domain.name !== ORCHESTRATOR_DOMAIN_NAME || domain.version !== ORCHESTRATOR_DOMAIN_VERSION) {
        fail('Phrase-less sessions can only sign Orchestrator intents')
    }

    if (input.typedData.primaryType !== 'Intent' || !typesMatch(input.typedData.types)) {
        fail('Phrase-less sessions can only sign Orchestrator intents')
    }

    const chainId = Number(asBigint(domain.chainId, 'chainId'))
    const chainName = getChainNameByChainId(chainId)
    const allowedChains = new Set(chainsForEnv(input.env).map((name) => getChainConfig(name).chainId))

    if (!chainName || !allowedChains.has(chainId)) {
        fail('Phrase-less session refused an Orchestrator intent for an unconfigured chain')
    }

    const orchestrator = getAddressesWithFallback(input.env, chainId)?.orchestrator

    if (!orchestrator) {
        fail('Phrase-less session refused an Orchestrator intent because the orchestrator is not deployed')
    }

    const verifyingContract = asAddress(domain.verifyingContract, 'verifyingContract')

    if (verifyingContract.toLowerCase() !== orchestrator.toLowerCase()) {
        fail('Phrase-less session refused an Orchestrator intent for a different verifying contract')
    }

    const message = input.typedData.message

    if (!isRecord(message)) {
        fail('Phrase-less sessions can only sign Orchestrator intents')
    }

    if (message.multichain !== false) {
        fail('Phrase-less session refused a multichain Orchestrator intent')
    }

    const preCalls = message.encodedPreCalls
    const fundTransfers = message.encodedFundTransfers

    if (!Array.isArray(preCalls) || preCalls.length !== 0) {
        fail('Phrase-less session refused an intent with pre-calls')
    }

    if (!Array.isArray(fundTransfers) || fundTransfers.length !== 0) {
        fail('Phrase-less session refused an intent with fund transfers')
    }

    if (!Array.isArray(message.calls)) {
        fail('Phrase-less session refused an intent whose calls could not be read')
    }

    const usdc = getUsdcTokenConfig(chainName).address
    const allowed = narrowCallAllowlist(input.env, chainId)
    let usdcMoved = 0n

    for (const call of message.calls) {
        if (!isRecord(call)) {
            fail('Phrase-less session refused an intent whose calls could not be read')
        }

        usdcMoved += usdcMovedByCall({
            to: asAddress(call.to, 'call.to'),
            value: asBigint(call.value, 'call.value'),
            data: asHex(call.data, 'call.data'),
            usdc,
            allowed,
        })
    }

    const paymentToken = asAddress(message.paymentToken, 'paymentToken')
    const paymentMax = asBigint(message.paymentMaxAmount, 'paymentMaxAmount')

    if (paymentMax !== 0n) {
        if (paymentToken.toLowerCase() !== usdc.toLowerCase()) {
            fail('Phrase-less session refused a non-USDC payment')
        }

        usdcMoved += paymentMax
    }

    if (usdcMoved > DEFAULT_SESSION_SPEND_LIMIT) {
        fail('Phrase-less session exceeds the 10 USDC daily budget')
    }

    return { chainId, usdc: usdcMoved }
}

export type SwapPaymentBounds = {
    /**
     * Quote fee in the chain's USDC. The signed amount must be at most this
     * fee and at most 5 USDC. A larger fee does not raise the ceiling.
     * Omitted means the ceiling is the only amount bound.
     */
    feeAmount?: bigint
    /** Expected payment recipient. Omitted means the zero address. */
    recipient?: Address
}

const ERC20_TRANSFER_SELECTORS: Record<string, string> = {
    '0xa9059cbb': 'transfer',
    '0x23b872dd': 'transferFrom',
}

function settlerAddresses(chainId: number): Set<string> {
    const settlers = new Set<string>()

    for (const env of ['prod', 'stage', 'dev'] as const) {
        const settler = getAddressesWithFallback(env, chainId)?.simpleSettler

        if (settler && settler !== zeroAddress) settlers.add(settler.toLowerCase())
    }

    return settlers
}

function assertSingleChainSwap(message: {
    settler?: unknown
    multichain?: unknown
    encodedFundTransfers?: unknown
    encodedPreCalls?: unknown
}): void {
    const settler =
        message.settler === undefined ? zeroAddress : asAddress(message.settler, 'settler')

    if (
        message.multichain !== false ||
        !Array.isArray(message.encodedFundTransfers) ||
        message.encodedFundTransfers.length !== 0 ||
        settler !== zeroAddress
    ) {
        refuse(
            'MULTICHAIN_INTENT',
            'Swap session refused a multichain or cross-chain intent. Only a single-chain swap is signed.',
        )
    }

    if (!Array.isArray(message.encodedPreCalls) || message.encodedPreCalls.length !== 0) {
        refuse('PRE_CALLS', 'Swap session refused an intent with pre-calls.')
    }
}

function assertNoFundsOut(
    chainId: number,
    calls: readonly { to: Address; value: bigint; data: Hex }[],
): void {
    const settlers = settlerAddresses(chainId)
    const relayTargets = new Set(relayEntryPoints(chainId).map((entry) => entry.target.toLowerCase()))

    for (const call of calls) {
        const target = call.to.toLowerCase()

        if (settlers.has(target)) {
            refuse('SETTLER_CALL', `Swap session refused a call to the settler ${call.to}.`)
        }

        const transfer = ERC20_TRANSFER_SELECTORS[selectorOf(call.data)]

        if (transfer) {
            refuse(
                'FUNDS_OUT',
                `Swap session refused ${transfer} on ${call.to}. A swap does not transfer tokens out.`,
            )
        }

        if (call.value !== 0n && !relayTargets.has(target)) {
            refuse(
                'FUNDS_OUT',
                `Swap session refused native value ${call.value} sent to ${call.to}, which is not a Relay contract.`,
            )
        }
    }
}

/**
 * A phrase-confirmed swap session may sign only a single-chain Orchestrator
 * intent with no pre-calls, fund transfers, or settler, whose calls pass the
 * relay quote reviewer and whose payment is the quote fee in that chain's
 * USDC, at most 5 USDC, paid to the expected recipient.
 * Any other typed data is refused.
 */
export function reviewSwapSessionSignature(typedData: unknown, bounds?: SwapPaymentBounds): void {
    if (!isRecord(typedData)) {
        fail('Swap session refused typed data that is not an Orchestrator intent')
    }

    const domain = typedData.domain

    if (!isRecord(domain)) {
        fail('Swap session refused typed data that is not an Orchestrator intent')
    }

    if (domain.name !== ORCHESTRATOR_DOMAIN_NAME || domain.version !== ORCHESTRATOR_DOMAIN_VERSION) {
        fail('Swap session refused typed data that is not an Orchestrator intent')
    }

    if (typedData.primaryType !== 'Intent' || !typesMatch(typedData.types)) {
        fail('Swap session refused typed data that is not an Orchestrator intent')
    }

    const chainId = Number(asBigint(domain.chainId, 'chainId'))
    const chainName = getChainNameByChainId(chainId)

    if (!chainName) {
        fail('Swap session refused an Orchestrator intent for an unconfigured chain')
    }

    const orchestrator = getAddressesWithFallback('prod', chainId)?.orchestrator
        ?? getAddressesWithFallback('stage', chainId)?.orchestrator
        ?? getAddressesWithFallback('dev', chainId)?.orchestrator

    if (!orchestrator) {
        fail('Swap session refused an Orchestrator intent because the orchestrator is not configured')
    }

    const verifyingContract = asAddress(domain.verifyingContract, 'verifyingContract')

    if (verifyingContract.toLowerCase() !== orchestrator.toLowerCase()) {
        fail('Swap session refused an Orchestrator intent for a different verifying contract')
    }

    const message = typedData.message

    if (!isRecord(message) || !Array.isArray(message.calls)) {
        fail('Swap session refused an intent whose calls could not be read')
    }

    assertSingleChainSwap(message)
    const user = asAddress(message.eoa, 'eoa')
    const calls: { to: Address; value: bigint; data: Hex }[] = []

    for (const call of message.calls) {
        if (!isRecord(call)) {
            fail('Swap session refused an intent whose calls could not be read')
        }

        calls.push({
            to: asAddress(call.to, 'call.to'),
            value: asBigint(call.value, 'call.value'),
            data: asHex(call.data, 'call.data'),
        })
    }

    if (calls.length === 0) {
        fail('Swap session refused an intent with no calls')
    }

    assertNoFundsOut(chainId, calls)

    try {
        reviewRelayIntentCalls({ chainId, user, calls })
    } catch (error) {
        if (error instanceof RelayQuoteRejected) {
            fail(error.message)
        }

        throw error
    }

    const paymentToken =
        message.paymentToken === undefined ? zeroAddress : asAddress(message.paymentToken, 'paymentToken')

    const paymentMax =
        message.paymentMaxAmount === undefined
            ? 0n
            : asBigint(message.paymentMaxAmount, 'paymentMaxAmount')

    const statedAmount =
        message.paymentAmount === undefined
            ? paymentMax
            : asBigint(message.paymentAmount, 'paymentAmount')

    const paymentRecipient =
        message.paymentRecipient === undefined
            ? zeroAddress
            : asAddress(message.paymentRecipient, 'paymentRecipient')

    const usdc = getUsdcTokenConfig(chainName).address
    const quotedFee = bounds?.feeAmount ?? PAID_FEE_CAP

    try {
        reviewQuotePayment({
            paymentToken,
            paymentAmount: statedAmount > paymentMax ? statedAmount : paymentMax,
            paymentRecipient,
            feeToken: usdc,
            feeAmount: quotedFee,
            recipient: bounds?.recipient ?? zeroAddress,
        })
    } catch (error) {
        if (error instanceof QuotePaymentRejected) fail(error.message)
        throw error
    }
}
