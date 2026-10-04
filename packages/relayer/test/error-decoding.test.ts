/**
 * Unit tests for contract error decoding
 *
 * Tests decodeOrchestratorError and contractErrorToRpcError functions.
 */

import { describe, it, expect } from 'vitest'
import { encodeErrorResult, type Hex } from 'viem'
import { orchestratorAbi } from '@nubl/contracts/abis'

import {
    INVALID_SIGNATURE,
    INSUFFICIENT_FUNDS,
    CONTRACT_ERROR,
    INTENT_EXPIRED,
    decodeOrchestratorError,
    mapErrorNameToCode,
    contractErrorToRpcError,
    RpcError,
} from '../src/rpc/errors'

describe('decodeOrchestratorError', () => {
    it('decodes PaymentError', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'PaymentError',
        })

        const decoded = decodeOrchestratorError(encoded)

        expect(decoded).not.toBeNull()
        expect(decoded?.errorName).toBe('PaymentError')
    })

    it('decodes VerificationError', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'VerificationError',
        })

        const decoded = decodeOrchestratorError(encoded)

        expect(decoded).not.toBeNull()
        expect(decoded?.errorName).toBe('VerificationError')
    })

    it('decodes CallError', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'CallError',
        })

        const decoded = decodeOrchestratorError(encoded)

        expect(decoded).not.toBeNull()
        expect(decoded?.errorName).toBe('CallError')
    })

    it('decodes InsufficientGas', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'InsufficientGas',
        })

        const decoded = decodeOrchestratorError(encoded)

        expect(decoded).not.toBeNull()
        expect(decoded?.errorName).toBe('InsufficientGas')
    })

    it('decodes IntentExpired', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'IntentExpired',
        })

        const decoded = decodeOrchestratorError(encoded)

        expect(decoded).not.toBeNull()
        expect(decoded?.errorName).toBe('IntentExpired')
    })

    it('decodes SimulationPassed with args', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'SimulationPassed',
            args: [500000n],
        })

        const decoded = decodeOrchestratorError(encoded)

        expect(decoded).not.toBeNull()
        expect(decoded?.errorName).toBe('SimulationPassed')
        expect(decoded?.args).toHaveLength(1)
        expect(decoded?.args[0]).toBe(500000n)
    })

    it('decodes PreCallVerificationError', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'PreCallVerificationError',
        })

        const decoded = decodeOrchestratorError(encoded)

        expect(decoded).not.toBeNull()
        expect(decoded?.errorName).toBe('PreCallVerificationError')
    })

    it('returns null for unknown error selector', () => {
        // Random 4-byte selector that doesn't match any error
        const unknownError = '0xdeadbeef' as Hex

        const decoded = decodeOrchestratorError(unknownError)

        expect(decoded).toBeNull()
    })

    it('returns null for empty data', () => {
        const decoded = decodeOrchestratorError('0x' as Hex)
        expect(decoded).toBeNull()
    })

    it('returns null for invalid hex', () => {
        const decoded = decodeOrchestratorError('0x123' as Hex)
        expect(decoded).toBeNull()
    })
})

describe('mapErrorNameToCode', () => {
    it('maps IntentExpired to INTENT_EXPIRED', () => {
        expect(mapErrorNameToCode('IntentExpired')).toBe(INTENT_EXPIRED)
    })

    it('maps PaymentError to INSUFFICIENT_FUNDS', () => {
        expect(mapErrorNameToCode('PaymentError')).toBe(INSUFFICIENT_FUNDS)
    })

    it('maps InsufficientGas to INSUFFICIENT_FUNDS', () => {
        expect(mapErrorNameToCode('InsufficientGas')).toBe(INSUFFICIENT_FUNDS)
    })

    it('maps VerificationError to INVALID_SIGNATURE', () => {
        expect(mapErrorNameToCode('VerificationError')).toBe(INVALID_SIGNATURE)
    })

    it('maps PreCallVerificationError to INVALID_SIGNATURE', () => {
        expect(mapErrorNameToCode('PreCallVerificationError')).toBe(INVALID_SIGNATURE)
    })

    it('maps unknown errors to CONTRACT_ERROR', () => {
        expect(mapErrorNameToCode('CallError')).toBe(CONTRACT_ERROR)
        expect(mapErrorNameToCode('SomeUnknownError')).toBe(CONTRACT_ERROR)
    })
})

describe('error selector extraction', () => {
    it('extracts 4-byte selector from encoded error', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'PaymentError',
        })

        // First 4 bytes (8 hex chars + 0x prefix = 10 chars)
        const selector = encoded.slice(0, 10)
        expect(selector).toHaveLength(10)
        expect(selector).toMatch(/^0x[a-f0-9]{8}$/)
    })

    it('different errors have different selectors', () => {
        const errors = ['PaymentError', 'VerificationError', 'CallError', 'IntentExpired'] as const

        const selectors = errors.map((errorName) => {
            const encoded = encodeErrorResult({
                abi: orchestratorAbi,
                errorName,
            })
            return encoded.slice(0, 10)
        })

        const uniqueSelectors = new Set(selectors)
        expect(uniqueSelectors.size).toBe(errors.length)
    })
})

describe('contractErrorToRpcError', () => {
    it('creates RpcError with correct code for known error', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'IntentExpired',
        })

        const rpcError = contractErrorToRpcError(encoded)

        expect(rpcError).toBeInstanceOf(RpcError)
        expect(rpcError.code).toBe(INTENT_EXPIRED)
        expect(rpcError.message).toBe('IntentExpired')
    })

    it('includes args in error data', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'SimulationPassed',
            args: [123456n],
        })

        const rpcError = contractErrorToRpcError(encoded)

        expect(rpcError.data).toHaveProperty('args')
        expect((rpcError.data as { args: unknown[] }).args[0]).toBe(123456n)
    })

    it('includes original data in error', () => {
        const encoded = encodeErrorResult({
            abi: orchestratorAbi,
            errorName: 'PaymentError',
        })

        const rpcError = contractErrorToRpcError(encoded)

        expect(rpcError.data).toHaveProperty('data', encoded)
    })

    it('returns CONTRACT_ERROR for unknown error', () => {
        const unknownError = '0xdeadbeef' as Hex

        const rpcError = contractErrorToRpcError(unknownError)

        expect(rpcError.code).toBe(CONTRACT_ERROR)
        expect(rpcError.message).toBe('Unknown contract error')
    })
})
