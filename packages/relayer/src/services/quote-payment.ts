import { zeroAddress, type Address } from 'viem'
import { z } from 'zod'

import { INVALID_PARAMS, RpcError } from '../rpc/errors'
import { convertToFeeToken } from './fees'

/**
 * Inputs the relayer itself wrote into the quote. `paymentAmount` is not one of
 * them: the client can rewrite that field, and the user signature covers
 * `paymentMaxAmount` only.
 */
export interface QuotePaymentParts {
    txGas: number | string | bigint
    maxFeePerGas: number | string | bigint
    paymentToken?: Address
    paymentTokenDecimals?: number
    /** Fee-token units per 1 native token, scaled by 1e18. Required for ERC-20 fees. */
    nativeRate?: string | bigint
}

function coerceNonNegative(value: number | string | bigint | undefined, label: string): bigint {
    const asBigint = z.bigint().safeParse(value)

    if (asBigint.success) {
        if (asBigint.data < 0n) {
            throw new RpcError(INVALID_PARAMS, `Invalid ${label}`)
        }

        return asBigint.data
    }

    const asNumber = z.number().refine(Number.isSafeInteger).safeParse(value)

    if (asNumber.success) {
        if (asNumber.data < 0) {
            throw new RpcError(INVALID_PARAMS, `Invalid ${label}`)
        }

        return BigInt(asNumber.data)
    }

    const asString = z.string().regex(/^(0x[0-9a-fA-F]+|[0-9]+)$/).safeParse(value)

    if (asString.success) {
        const parsed = BigInt(asString.data)

        if (parsed < 0n) {
            throw new RpcError(INVALID_PARAMS, `Invalid ${label}`)
        }

        return parsed
    }

    throw new RpcError(INVALID_PARAMS, `Invalid ${label}`)
}

/**
 * Fee the relayer will collect. Native fees are txGas * maxFeePerGas.
 * ERC-20 fees use the same conversion as prepareCalls (`nativeRate` on the quote).
 */
export function recomputeQuotePaymentAmount(parts: QuotePaymentParts): bigint {
    const nativeAmount =
        coerceNonNegative(parts.txGas, 'txGas') *
        coerceNonNegative(parts.maxFeePerGas, 'maxFeePerGas')

    const token = parts.paymentToken

    if (!token || token.toLowerCase() === zeroAddress.toLowerCase()) {
        return nativeAmount
    }

    if (parts.nativeRate === undefined || parts.nativeRate === '') {
        throw new RpcError(INVALID_PARAMS, 'Quote is missing nativeRate for fee-token payment')
    }

    const decimals = parts.paymentTokenDecimals

    const decimalsParsed = z
        .number()
        .refine((value) => Number.isInteger(value) && value >= 0 && value <= 36)
        .safeParse(decimals)

    if (!decimalsParsed.success) {
        throw new RpcError(INVALID_PARAMS, 'Quote paymentTokenDecimals is invalid')
    }

    return convertToFeeToken(
        nativeAmount,
        coerceNonNegative(parts.nativeRate, 'nativeRate'),
        decimalsParsed.data,
    )
}
