import { expect, test } from 'bun:test'
import { hasDelegationCode, DELEGATION_CODE_PREFIX } from '../src/lib/delegation-utils'

test('hasDelegationCode returns true for valid EIP-7702 prefix', () => {
    expect(hasDelegationCode('0xef0100abcdef1234567890')).toBe(true)
})

test('hasDelegationCode returns true for uppercase prefix', () => {
    expect(hasDelegationCode('0xEF0100abcdef')).toBe(true)
})

test('hasDelegationCode returns false for empty code', () => {
    expect(hasDelegationCode('0x')).toBe(false)
})

test('hasDelegationCode returns false for undefined', () => {
    expect(hasDelegationCode(undefined)).toBe(false)
})

test('hasDelegationCode returns false for regular contract code', () => {
    expect(hasDelegationCode('0x6080604052')).toBe(false)
})

test('DELEGATION_CODE_PREFIX is the expected value', () => {
    expect(DELEGATION_CODE_PREFIX).toBe('0xef0100')
})
