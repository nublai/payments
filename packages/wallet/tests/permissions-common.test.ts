import { expect, test } from 'bun:test'
import { parseSpendLimitUnits } from '../src/lib/permissions-common'

test('parseSpendLimitUnits parses integer token amount with 6 decimals', () => {
    expect(parseSpendLimitUnits('10')).toBe(10_000_000n)
})

test('parseSpendLimitUnits rejects ambiguous large integers that look like base units', () => {
    expect(() => parseSpendLimitUnits('1000000')).toThrow('looks like raw base units')
})
