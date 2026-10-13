import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { decodeIntentError, isKnownIntentError } from '../../src/utils/errors.js'

describe('decodeIntentError', () => {
    it('maps a known 4-byte selector', () => {
        expect(decodeIntentError('0x9054c912')).toBe('ExceededSpendLimit')
        expect(decodeIntentError('0x9054C912')).toBe('ExceededSpendLimit')
        expect(isKnownIntentError('0x9054c912')).toBe(true)
    })

    it('returns undefined for an unknown 4-byte selector', () => {
        expect(decodeIntentError('0xdeadbeef')).toBeUndefined()
        expect(isKnownIntentError('0xdeadbeef')).toBe(false)
    })

    it('returns undefined for Object.prototype keys', () => {
        // SAFETY: this negative case feeds a prototype key, which is not a 4-byte selector.
        expect(decodeIntentError('constructor' as Hex)).toBeUndefined()
        // SAFETY: this negative case feeds a prototype key, which is not a 4-byte selector.
        expect(decodeIntentError('__proto__' as Hex)).toBeUndefined()
        // SAFETY: this negative case feeds a prototype key, which is not a 4-byte selector.
        expect(isKnownIntentError('constructor' as Hex)).toBe(false)
        // SAFETY: this negative case feeds a prototype key, which is not a 4-byte selector.
        expect(isKnownIntentError('__proto__' as Hex)).toBe(false)
    })
})
