/**
 * RPC utility functions for parameter validation and extraction
 */

import type { Address } from 'viem'
import { RpcError, INVALID_PARAMS } from '../rpc/errors'
import type { JsonRpcParams } from '../rpc/types'

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

/**
 * Validate and return an Ethereum address
 * @throws RpcError if address format is invalid
 */
export function validateAddress(value: string, paramName: string): Address {
    if (!ADDRESS_REGEX.test(value)) {
        throw new RpcError(INVALID_PARAMS, `Invalid ${paramName}: must be a valid Ethereum address`)
    }

    return value as Address
}

/**
 * Require a parameter to be present (not null/undefined)
 * @throws RpcError if value is missing
 */
export function requireParam<T>(value: T | null | undefined, paramName: string): T {
    if (value === null || value === undefined) {
        throw new RpcError(INVALID_PARAMS, `Missing required parameter: ${paramName}`)
    }

    return value
}

/**
 * Unwrap JSON-RPC params (array or object) into a single typed object.
 */
export function unwrapParams<T>(params: JsonRpcParams | T | undefined): T | undefined {
    if (Array.isArray(params)) {
        return params[0] as T | undefined
    }

    return params as T | undefined
}

/**
 * Parse a hex-encoded chain ID (e.g. "0x2105") to number.
 * @throws RpcError if parsing fails.
 */
export function parseHexChainId(value: string, paramName: string = 'chainId'): number {
    const parsed = Number.parseInt(value, 16)

    if (!Number.isFinite(parsed)) {
        throw new RpcError(INVALID_PARAMS, `Invalid ${paramName}: ${value}`)
    }

    return parsed
}
