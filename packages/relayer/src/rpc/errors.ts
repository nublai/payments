/**
 * JSON-RPC 2.0 Error Codes
 *
 * Standard error codes as defined in https://www.jsonrpc.org/specification
 * Plus custom server error codes for relay-specific errors.
 */

import { decodeErrorResult, type Hex } from 'viem'
import { orchestratorAbi } from '@nubl/contracts/abis'

// =============================================================================
// Standard JSON-RPC 2.0 Error Codes
// =============================================================================

/** Invalid JSON was received by the server */
export const PARSE_ERROR = -32700

/** The JSON sent is not a valid Request object */
export const INVALID_REQUEST = -32600

/** The method does not exist / is not available */
export const METHOD_NOT_FOUND = -32601

/** Invalid method parameter(s) */
export const INVALID_PARAMS = -32602

/** Internal JSON-RPC error */
export const INTERNAL_ERROR = -32603

// =============================================================================
// Server Error Codes (-32000 to -32099)
// =============================================================================

/** Generic server error */
export const SERVER_ERROR = -32000

/** Method exists but is not yet implemented */
export const METHOD_NOT_IMPLEMENTED = -32001

/** Service unavailable (pool at capacity, etc.) */
export const SERVICE_UNAVAILABLE = -32002

/** Contract execution error */
export const CONTRACT_ERROR = -32003

/** Simulation failed */
export const SIMULATION_FAILED = -32004

/** Invalid signature */
export const INVALID_SIGNATURE = -32005

/** Nonce error (already used, invalid) */
export const NONCE_ERROR = -32006

/** Insufficient funds */
export const INSUFFICIENT_FUNDS = -32007

/** Intent expired */
export const INTENT_EXPIRED = -32008

/** Account not delegated to Account */
export const ACCOUNT_NOT_DELEGATED = -32009

/** Quote expired (TTL exceeded) */
export const QUOTE_EXPIRED = -32010

/** Invalid quote signature */
export const INVALID_QUOTE_SIGNATURE = -32011

/** Payment amount exceeds user's max amount */
export const PAYMENT_EXCEEDS_MAX = -32012

/** Draft conflict - active draft exists for this nonce lane with a different prepare key */
export const DRAFT_CONFLICT = -32013

/** Upgrade prepare/broadcast rate limit exceeded */
export const RATE_LIMITED = -32014

// =============================================================================
// Error Messages
// =============================================================================

export const ERROR_MESSAGES: Record<number, string> = {
    [PARSE_ERROR]: 'Parse error',
    [INVALID_REQUEST]: 'Invalid Request',
    [METHOD_NOT_FOUND]: 'Method not found',
    [INVALID_PARAMS]: 'Invalid params',
    [INTERNAL_ERROR]: 'Internal error',
    [SERVER_ERROR]: 'Server error',
    [METHOD_NOT_IMPLEMENTED]: 'Method not implemented',
    [SERVICE_UNAVAILABLE]: 'Service unavailable',
    [CONTRACT_ERROR]: 'Contract error',
    [SIMULATION_FAILED]: 'Simulation failed',
    [INVALID_SIGNATURE]: 'Invalid signature',
    [NONCE_ERROR]: 'Nonce error',
    [INSUFFICIENT_FUNDS]: 'Insufficient funds',
    [INTENT_EXPIRED]: 'Intent expired',
    [ACCOUNT_NOT_DELEGATED]: 'Account not delegated',
    [QUOTE_EXPIRED]: 'Quote expired',
    [INVALID_QUOTE_SIGNATURE]: 'Invalid quote signature',
    [PAYMENT_EXCEEDS_MAX]: 'Payment amount exceeds maximum',
    [DRAFT_CONFLICT]: 'Draft conflict',
    [RATE_LIMITED]: 'Upgrade rate limit exceeded',
}

// =============================================================================
// RpcError Class
// =============================================================================

/**
 * Custom error class for JSON-RPC errors
 *
 * Throw this from method handlers to return a structured error response.
 */
export class RpcError extends Error {
    public readonly code: number
    public readonly data?: unknown

    constructor(code: number, message?: string, data?: unknown) {
        super(message ?? ERROR_MESSAGES[code] ?? 'Unknown error')
        this.name = 'RpcError'
        this.code = code
        this.data = data
    }

    /**
     * Convert to JSON-RPC error object
     */
    toJSON(): { code: number; message: string; data?: unknown } {
        return {
            code: this.code,
            message: this.message,
            ...(this.data !== undefined && { data: this.data }),
        }
    }
}

// =============================================================================
// Contract Error Decoding
// =============================================================================

/**
 * Decoded contract error result
 */
export interface DecodedContractError {
    errorName: string
    args: readonly unknown[]
}

/**
 * Decode Orchestrator contract revert data
 *
 * Uses viem's decodeErrorResult with the orchestratorAbi to decode
 * custom errors returned by the Orchestrator contract.
 *
 * @param data - The hex-encoded revert data
 * @returns Decoded error with name and args, or null if decoding fails
 */
export function decodeOrchestratorError(data: Hex): DecodedContractError | null {
    try {
        return decodeErrorResult({ abi: orchestratorAbi, data })
    } catch {
        return null
    }
}

/**
 * Map Orchestrator error names to RpcError codes
 *
 * Maps known contract errors to appropriate JSON-RPC error codes.
 */
export function mapErrorNameToCode(errorName: string): number {
    switch (errorName) {
        case 'IntentExpired':
            return INTENT_EXPIRED
        case 'PaymentError':
        case 'InsufficientGas':
            return INSUFFICIENT_FUNDS
        case 'VerificationError':
        case 'PreCallVerificationError':
            return INVALID_SIGNATURE
        default:
            return CONTRACT_ERROR
    }
}

/**
 * Convert contract error data to an RpcError
 *
 * Decodes the error data and creates an appropriate RpcError
 * with the correct error code and message.
 *
 * @param errorData - The hex-encoded revert data
 * @returns RpcError with appropriate code and decoded error info
 */
export function contractErrorToRpcError(errorData: Hex): RpcError {
    const decoded = decodeOrchestratorError(errorData)

    if (decoded) {
        const code = mapErrorNameToCode(decoded.errorName)
        return new RpcError(code, decoded.errorName, {
            args: decoded.args,
            data: errorData,
        })
    }

    return new RpcError(CONTRACT_ERROR, 'Unknown contract error', { data: errorData })
}
