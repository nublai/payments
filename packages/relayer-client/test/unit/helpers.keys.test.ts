import { describe, it, expect } from 'vitest'
import type { GetKeysResponse } from '../../src/actions/getKeys.js'
import { findAuthorizedKey, getChainKeys } from '../../src/helpers/keys.js'

const KEYS_FIXTURE: GetKeysResponse = {
    '0x2105': [
        {
            hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            type: 'secp256k1',
            role: 'admin',
            permissions: [],
            expiry: '0x00',
            publicKey: '0x',
        },
    ],
    '0x14A33': [
        {
            hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            type: 'secp256k1',
            role: 'normal',
            permissions: [],
            expiry: '0x00',
            publicKey: '0x',
        },
    ],
}

describe('helpers/keys', () => {
    it('returns chain keys via exact hex key match', () => {
        const keys = getChainKeys(KEYS_FIXTURE, 8453)
        expect(keys).toHaveLength(1)
        expect(keys[0].hash).toBe(
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        )
    })

    it('returns empty array when chain is not present', () => {
        const keys = getChainKeys(KEYS_FIXTURE, 10)
        expect(keys).toEqual([])
    })

    it('finds authorized key by hash (case-insensitive)', () => {
        const match = findAuthorizedKey(
            KEYS_FIXTURE,
            8453,
            '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        )

        expect(match?.role).toBe('admin')
    })

    it('returns undefined for missing hash', () => {
        const match = findAuthorizedKey(
            KEYS_FIXTURE,
            8453,
            '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        )

        expect(match).toBeUndefined()
    })
})
