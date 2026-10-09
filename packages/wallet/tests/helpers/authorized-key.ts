import type { AuthorizedKeyInfo, GetKeysResponse } from '@nubl/relayer-client'
import type { Hex } from 'viem'
import { hex } from './hex'

/** Complete authorized key. Tests that only read `hash` can ignore the rest. */
export function testAuthorizedKey(hash: Hex, overrides?: Partial<AuthorizedKeyInfo>): AuthorizedKeyInfo {
    return {
        hash,
        expiry: hex('0x0'),
        type: 'secp256k1',
        role: 'normal',
        publicKey: hex('0x00'),
        permissions: [],
        ...overrides,
    }
}

/** GetKeysResponse with one chain's keys. */
export function testKeys(chainHex: `0x${string}`, keys: AuthorizedKeyInfo[]): GetKeysResponse {
    return { [chainHex]: keys }
}

/** One authorized key on Base (`0x2105`). */
export function testBaseKeys(hash: Hex, overrides?: Partial<AuthorizedKeyInfo>): GetKeysResponse {
    return testKeys('0x2105', [testAuthorizedKey(hash, overrides)])
}
