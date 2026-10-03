import { describe, expect, it } from 'vitest'

import {
    DEFAULT_AUTH_PROTECTED_METHODS,
    parseAuthProtectedMethods,
    extractAuthRequirement,
} from '../../src/auth/policy'

describe('auth policy', () => {
    it('uses default protected methods when env is missing', () => {
        const methods = parseAuthProtectedMethods(undefined)
        expect([...methods]).toEqual(DEFAULT_AUTH_PROTECTED_METHODS)
    })

    it('parses comma-separated values with trimming', () => {
        const methods = parseAuthProtectedMethods(
            ' wallet_sendPreparedCalls, wallet_prepareCalls ,  wallet_health ',
        )

        expect(methods.has('wallet_sendPreparedCalls')).toBe(true)
        expect(methods.has('wallet_prepareCalls')).toBe(true)
        expect(methods.has('wallet_health')).toBe(true)
        expect(methods.size).toBe(3)
    })

    it('falls back to default methods when parsed value is empty', () => {
        const methods = parseAuthProtectedMethods(' ,   , ')
        expect([...methods]).toEqual(DEFAULT_AUTH_PROTECTED_METHODS)
    })

    it('detects protected method in single request', () => {
        const result = extractAuthRequirement(
            { jsonrpc: '2.0', id: 1, method: 'wallet_sendPreparedCalls', params: [] },
            new Set(['wallet_sendPreparedCalls']),
        )

        expect(result).toEqual({ requiresAuth: true, id: 1 })
    })

    it('detects protected method in mixed batch', () => {
        const result = extractAuthRequirement(
            [
                { jsonrpc: '2.0', id: 1, method: 'wallet_health', params: [] },
                { jsonrpc: '2.0', id: 2, method: 'wallet_prepareCalls', params: [] },
            ],
            new Set(['wallet_sendPreparedCalls', 'wallet_prepareCalls']),
        )

        expect(result).toEqual({ requiresAuth: true, id: null })
    })

    it('does not require auth for non-protected methods', () => {
        const result = extractAuthRequirement(
            { jsonrpc: '2.0', id: 'abc', method: 'wallet_health', params: [] },
            new Set(['wallet_sendPreparedCalls']),
        )

        expect(result).toEqual({ requiresAuth: false, id: 'abc' })
    })

    it('normalizes non-jsonrpc id values to null', () => {
        const result = extractAuthRequirement(
            { jsonrpc: '2.0', id: { nested: true }, method: 'wallet_health', params: [] },
            new Set(['wallet_sendPreparedCalls']),
        )

        expect(result).toEqual({ requiresAuth: false, id: null })
    })
})
