import { expect, test } from 'bun:test'
import { decodeFunctionData, type Address, type Hex } from 'viem'
import { accountAbi } from '@nubl/contracts/abis'
import { INTENT_EXPIRY_TTL_SECONDS } from '@nubl/relayer-client'
import {
    authorizeKeyExpiryCall,
    planQuoteKeyExpiry,
    QUOTE_KEY_EXPIRY_SECONDS,
    restoreQuoteKeyExpiryCall,
} from '../src/lib/quote-key-expiry'

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111'

const PUBLIC_KEY: Hex = '0x1234'

test('a never-expiring swap key is bounded to two intent TTLs for a quote', () => {
    expect(INTENT_EXPIRY_TTL_SECONDS).toBe(3600n)
    expect(QUOTE_KEY_EXPIRY_SECONDS).toBe(7200n)
    const now = 1_700_000_000n
    const plan = planQuoteKeyExpiry({ now, currentExpiry: 0n })
    expect(plan).toEqual({
        previous: 0n,
        installed: now + 7200n,
        changed: true })
})

test('a sooner key expiry is not extended by a quote', () => {
    const now = 1_700_000_000n
    const sooner = now + 60n
    const plan = planQuoteKeyExpiry({ now, currentExpiry: sooner })
    expect(plan.changed).toBe(false)
    expect(plan.installed).toBe(sooner)
    expect(plan.previous).toBe(sooner)
})

test('quote expiry is an authorize of the same key', () => {
    const expiry = 1_700_007_200n

    const call = authorizeKeyExpiryCall({
        account: ACCOUNT,
        key: { expiry: 0n, keyType: 0, isSuperAdmin: false, publicKey: PUBLIC_KEY },
        expiry })

    expect(call.target).toBe(ACCOUNT)
    expect(call.value).toBe(0n)
    const decoded = decodeFunctionData({ abi: accountAbi, data: call.data })
    expect(decoded.functionName).toBe('authorize')
    expect(decoded.args?.[0]).toEqual({
        expiry: Number(expiry),
        keyType: 0,
        isSuperAdmin: false,
        publicKey: PUBLIC_KEY })
})

test('a revoked swap key is not recreated when the quote expiry is restored', () => {
    const previous = { expiry: 0n, keyType: 0, isSuperAdmin: false, publicKey: PUBLIC_KEY }
    expect(
        restoreQuoteKeyExpiryCall({
            account: ACCOUNT,
            previous,
            keyStillExists: false }),
    ).toEqual([])
    expect(
        restoreQuoteKeyExpiryCall({
            account: ACCOUNT,
            previous: undefined,
            keyStillExists: true }),
    ).toEqual([])
    const installedExpiry = 1_700_007_200n

    const installed = {
        expiry: installedExpiry,
        keyType: 0,
        isSuperAdmin: false,
        publicKey: PUBLIC_KEY,
        permissions: [],
        limits: [] }

    const calls = restoreQuoteKeyExpiryCall({
        account: ACCOUNT,
        previous,
        keyStillExists: true,
        installed,
        live: installed })

    expect(calls).toHaveLength(1)
    const decoded = decodeFunctionData({ abi: accountAbi, data: calls[0]!.data })
    expect(decoded.functionName).toBe('authorize')
    expect(decoded.args?.[0]).toMatchObject({ expiry: 0, publicKey: PUBLIC_KEY })
})
