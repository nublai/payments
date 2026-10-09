/**
 * Serialization utilities for intent/API data
 */

import type { Address, Hex } from 'viem'
import type { Intent, Call } from '../types'
import type { PrepareCallsContext } from '../actions/prepareCalls'

/** Values JSON.stringify can pass into a replacer, including symbol and function. */
type JsonReplacerValue =
    | string
    | number
    | boolean
    | bigint
    | symbol
    | object
    | ((...args: never[]) => unknown)
    | null
    | undefined

/**
 * JSON replacer that converts BigInt to string for serialization
 */
export function bigIntReplacer(_key: string, value: unknown): JsonReplacerValue {
    if (typeof value === 'bigint') return value.toString()

    // SAFETY: JSON.stringify calls the replacer with a JS value. JsonReplacerValue is that set (string | number | boolean | bigint | symbol | object | function | null | undefined). unknown is not assignable to the union without a typeof walk (no-runtime-typeof).
    return value as JsonReplacerValue
}

/**
 * Serialized call format for API requests
 */
export interface SerializedCall {
    target: Address
    value: string
    data: Hex
}

/**
 * Serialized intent format for API requests
 */
export interface SerializedIntent {
    eoa: Address
    calls: SerializedCall[]
    nonce: string
    combinedGas: string
    expiry: string // Renamed from deadline
    signature: Hex
    // PreCalls (optional)
    encodedPreCalls?: Hex[]
    // Funding (optional)
    funder?: Address
    encodedFundTransfers?: Hex[]
    funderSignature?: Hex
    // Settler (optional)
    settler?: Address
    settlerContext?: Hex
    isMultichain?: boolean
    // Payment (optional)
    payer?: Address
    paymentToken?: Address
    paymentMaxAmount?: string
    paymentAmount?: string
    paymentRecipient?: Address
    paymentSignature?: Hex
    // Account implementation restriction (optional)
    supportedAccountImplementation?: Address
}

/**
 * Serialize a call for API transmission
 */
export function serializeCall(call: Call): SerializedCall {
    return {
        target: call.target,
        value: call.value.toString(),
        data: call.data,
    }
}

/**
 * Serialize a PrepareCallsContext to a JSON string for transport over string-only channels.
 */
export function serializeContext(context: PrepareCallsContext): string {
    return JSON.stringify(context, bigIntReplacer)
}

/**
 * Deserialize a JSON string back into a PrepareCallsContext.
 * Validates structural shape at the trust boundary.
 */
export function deserializeContext(serialized: string): PrepareCallsContext {
    const parsed: unknown = JSON.parse(serialized)

    if (parsed === null || parsed === undefined || typeof parsed !== 'object' || !('quote' in parsed)) {
        throw new Error('Invalid PrepareCallsContext: expected { quote: { quotes: [...] } }')
    }

    const obj = parsed as Record<string, unknown>

    if (
        obj.quote === null ||
        obj.quote === undefined ||
        typeof obj.quote !== 'object' ||
        !('quotes' in obj.quote) ||
        !Array.isArray((obj.quote as Record<string, unknown>).quotes)
    ) {
        throw new Error('Invalid PrepareCallsContext: expected { quote: { quotes: [...] } }')
    }

    return parsed as PrepareCallsContext
}

/**
 * Extract the chain ID (as a number) from a PrepareCallsContext.
 * Reads context.quote.quotes[0].chainId (hex string from the relayer).
 */
export function getChainIdFromContext(context: PrepareCallsContext): number {
    const quote = context.quote?.quotes?.[0]

    if (!quote?.chainId) {
        throw new Error('Cannot extract chainId from context: no quotes found')
    }

    const raw = quote.chainId
    const parsed = raw.startsWith('0x') ? Number.parseInt(raw.slice(2), 16) : Number(raw)

    if (!Number.isFinite(parsed)) {
        throw new Error(`Cannot extract chainId from context: invalid chainId "${raw}"`)
    }

    return parsed
}

/**
 * Serialize an intent for API transmission
 */
export function serializeIntent(intent: Intent): SerializedIntent {
    return {
        eoa: intent.eoa,
        calls: intent.calls.map(serializeCall),
        nonce: intent.nonce.toString(),
        combinedGas: intent.combinedGas.toString(),
        expiry: intent.expiry.toString(), // Renamed from deadline
        signature: intent.signature,
        // PreCalls
        encodedPreCalls: intent.encodedPreCalls,
        // Funding
        funder: intent.funder,
        encodedFundTransfers: intent.encodedFundTransfers,
        funderSignature: intent.funderSignature,
        // Settler
        settler: intent.settler,
        settlerContext: intent.settlerContext,
        isMultichain: intent.isMultichain,
        // Payment
        payer: intent.payer,
        paymentToken: intent.paymentToken,
        paymentMaxAmount: intent.paymentMaxAmount?.toString(),
        paymentAmount: intent.paymentAmount?.toString(),
        paymentRecipient: intent.paymentRecipient,
        paymentSignature: intent.paymentSignature,
        // Account implementation restriction
        supportedAccountImplementation: intent.supportedAccountImplementation,
    }
}
