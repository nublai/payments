import { expect, test } from 'bun:test'
import {
    parseTargetAddress,
    parseSelector,
    parseSpendLimit,
    toSpendPeriodEnum,
    normalizeSpendPeriod,
    getChainKeys,
    computeSessionKeyHash,
    buildPermissionDefaults,
    parseSessionName,
    parseDuration,
    parseExpiry,
    ANY_FUNCTION_SELECTOR,
} from '../src/lib/session-common'
import { ANY_TARGET, type GetKeysResponse } from '@nubl/relayer-client'
import { zeroAddress } from 'viem'

// --- parseTargetAddress ---

test('parseTargetAddress accepts a valid checksummed address', () => {
    const addr = parseTargetAddress('0x2222222222222222222222222222222222222222')
    expect(addr).toBe('0x2222222222222222222222222222222222222222')
})

test('parseTargetAddress rejects an invalid address', () => {
    expect(() => parseTargetAddress('not-an-address')).toThrow('Invalid target address')
})

test('parseTargetAddress rejects a short hex', () => {
    expect(() => parseTargetAddress('0x1234')).toThrow('Invalid target address')
})

// --- parseSelector ---

test('parseSelector accepts 0x-prefixed 4-byte selector', () => {
    expect(parseSelector('0xa9059cbb')).toBe('0xa9059cbb')
})

test('parseSelector accepts non-prefixed 4-byte selector', () => {
    expect(parseSelector('a9059cbb')).toBe('0xa9059cbb')
})

test('parseSelector rejects invalid selector', () => {
    expect(() => parseSelector('0x1234')).toThrow('Invalid selector')
})

test('parseSelector rejects too-long selector', () => {
    expect(() => parseSelector('0xa9059cbb00')).toThrow('Invalid selector')
})

// --- parseSpendLimit ---

test('parseSpendLimit parses integer USDC amount', () => {
    expect(parseSpendLimit('100')).toBe(100_000_000n)
})

test('parseSpendLimit parses decimal USDC amount', () => {
    expect(parseSpendLimit('10.5')).toBe(10_500_000n)
})

test('parseSpendLimit rejects too many decimals', () => {
    expect(() => parseSpendLimit('1.1234567')).toThrow('at most 6 decimal places')
})

test('parseSpendLimit rejects non-numeric input', () => {
    expect(() => parseSpendLimit('abc')).toThrow('positive decimal number')
})

test('parseSpendLimit rejects zero', () => {
    expect(() => parseSpendLimit('0')).toThrow('greater than zero')
})

test('parseSpendLimit trims whitespace', () => {
    expect(parseSpendLimit('  5  ')).toBe(5_000_000n)
})

test('parseSpendLimit rejects ambiguous large integers that look like base units', () => {
    expect(() => parseSpendLimit('1000000')).toThrow('looks like raw base units')
})

// --- toSpendPeriodEnum ---

test('toSpendPeriodEnum maps all known periods', () => {
    expect(toSpendPeriodEnum('minute')).toBe(0)
    expect(toSpendPeriodEnum('hour')).toBe(1)
    expect(toSpendPeriodEnum('day')).toBe(2)
    expect(toSpendPeriodEnum('week')).toBe(3)
    expect(toSpendPeriodEnum('month')).toBe(4)
    expect(toSpendPeriodEnum('year')).toBe(5)
    expect(toSpendPeriodEnum('forever')).toBe(6)
})

test('toSpendPeriodEnum rejects unknown period', () => {
    expect(() => toSpendPeriodEnum('quarterly' as any)).toThrow('Invalid spend period')
})

// --- normalizeSpendPeriod ---

test('normalizeSpendPeriod accepts valid periods', () => {
    expect(normalizeSpendPeriod('minute')).toBe('minute')
    expect(normalizeSpendPeriod('hour')).toBe('hour')
    expect(normalizeSpendPeriod('day')).toBe('day')
    expect(normalizeSpendPeriod('week')).toBe('week')
    expect(normalizeSpendPeriod('month')).toBe('month')
    expect(normalizeSpendPeriod('year')).toBe('year')
    expect(normalizeSpendPeriod('forever')).toBe('forever')
})

test('normalizeSpendPeriod rejects unknown period', () => {
    expect(() => normalizeSpendPeriod('quarterly')).toThrow('Invalid spend period')
})

// --- getChainKeys ---

test('getChainKeys finds keys by hex chain id', () => {
    const keys: GetKeysResponse = {
        '0x2105': [{ hash: '0xaa', type: 'secp256k1' } as any],
    }

    expect(getChainKeys(keys, 8453)).toHaveLength(1)
})

test('getChainKeys falls back to iterating entries', () => {
    const keys: GetKeysResponse = {
        '0x7a69': [{ hash: '0xbb' } as any],
    }

    expect(getChainKeys(keys, 31337)).toHaveLength(1)
})

test('getChainKeys returns empty for unknown chain', () => {
    const keys: GetKeysResponse = {
        '0x2105': [{ hash: '0xaa' } as any],
    }

    expect(getChainKeys(keys, 999)).toEqual([])
})

// --- computeSessionKeyHash ---

test('computeSessionKeyHash returns a deterministic 32-byte hash', () => {
    const hash = computeSessionKeyHash('0x1111111111111111111111111111111111111111')
    expect(hash).toMatch(/^0x[a-f0-9]{64}$/)
    // Deterministic
    expect(computeSessionKeyHash('0x1111111111111111111111111111111111111111')).toBe(hash)
})

test('computeSessionKeyHash differs for different addresses', () => {
    const hash1 = computeSessionKeyHash('0x1111111111111111111111111111111111111111')
    const hash2 = computeSessionKeyHash('0x2222222222222222222222222222222222222222')
    expect(hash1).not.toBe(hash2)
})

// --- buildPermissionDefaults ---

test('buildPermissionDefaults fullAccess returns wildcard permissions', () => {
    const result = buildPermissionDefaults({ fullAccess: true, chain: 'base' })
    expect(result.target).toBe(ANY_TARGET)
    expect(result.selectors).toEqual([ANY_FUNCTION_SELECTOR])
    expect(result.spendToken).toBe(zeroAddress)
    expect(result.spendLimit).toBe(2n ** 256n - 1n)
    expect(result.spendPeriod).toBe('forever')
})

test('buildPermissionDefaults fullAccess rejects scoped overrides', () => {
    expect(() =>
        buildPermissionDefaults({
            fullAccess: true,
            chain: 'base',
            spendLimit: 1_000_000n,
        }),
    ).toThrow(
        '--full-access cannot be combined with --target, --selector, --spend-limit, --spend-limit-raw, or --spend-period.',
    )
})

test('buildPermissionDefaults restricted uses USDC defaults', () => {
    const result = buildPermissionDefaults({ fullAccess: false, chain: 'base' })
    expect(result.spendLimit).toBe(10_000_000n) // 10 USDC
    expect(result.spendPeriod).toBe('day')
    // target should be the USDC token address for base
    expect(result.target).toMatch(/^0x[a-fA-F0-9]{40}$/)
})

test('buildPermissionDefaults uses custom target and selectors', () => {
    const target = '0x3333333333333333333333333333333333333333' as const
    const selectors = ['0xa9059cbb' as const]

    const result = buildPermissionDefaults({
        fullAccess: false,
        chain: 'base',
        target,
        selectors,
    })

    expect(result.target).toBe(target)
    expect(result.selectors).toEqual(selectors)
})

test('buildPermissionDefaults uses custom spend limit and period', () => {
    const result = buildPermissionDefaults({
        fullAccess: false,
        chain: 'base',
        spendLimit: 50_000_000n,
        spendPeriod: 'week',
    })

    expect(result.spendLimit).toBe(50_000_000n)
    expect(result.spendPeriod).toBe('week')
})

// --- parseSessionName ---

test('parseSessionName trims and validates', () => {
    expect(parseSessionName('  agent-1  ')).toBe('agent-1')
})

test('parseSessionName rejects empty string', () => {
    expect(() => parseSessionName('   ')).toThrow()
})

// --- parseDuration ---

test('parseDuration parses minutes', () => {
    expect(parseDuration('30m')).toBe(1800)
})

test('parseDuration parses hours', () => {
    expect(parseDuration('24h')).toBe(86400)
})

test('parseDuration parses days', () => {
    expect(parseDuration('7d')).toBe(604800)
})

test('parseDuration parses weeks', () => {
    expect(parseDuration('4w')).toBe(2419200)
})

test('parseDuration trims whitespace', () => {
    expect(parseDuration('  12h  ')).toBe(43200)
})

test('parseDuration rejects invalid format', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration')
})

test('parseDuration rejects unsupported unit', () => {
    expect(() => parseDuration('10s')).toThrow('Invalid duration')
})

test('parseDuration rejects zero', () => {
    expect(() => parseDuration('0h')).toThrow('greater than zero')
})

// --- parseExpiry ---

test('parseExpiry returns a future unix timestamp', () => {
    const before = Math.floor(Date.now() / 1000)
    const expiry = parseExpiry('1h')
    const after = Math.floor(Date.now() / 1000)
    expect(expiry).toBeGreaterThanOrEqual(before + 3600)
    expect(expiry).toBeLessThanOrEqual(after + 3600)
})
