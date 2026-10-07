import { zeroAddress, type Address } from 'viem'

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
    if (typeof value === 'bigint') {
        if (value < 0n) {
            throw new RpcError(INVALID_PARAMS, `Invalid ${label}`)
        }
        return value
    }
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RpcError(INVALID_PARAMS, `Invalid ${label}`)
        }
        return BigInt(value)
    }
    if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
        const parsed = BigInt(value)
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
    if (
        typeof decimals !== 'number' ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 36
    ) {
        throw new RpcError(INVALID_PARAMS, 'Quote paymentTokenDecimals is invalid')
    }

    return convertToFeeToken(
        nativeAmount,
        coerceNonNegative(parts.nativeRate, 'nativeRate'),
        decimals,
    )
}
