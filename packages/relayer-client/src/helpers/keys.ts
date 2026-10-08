import type { Hex } from 'viem'
import type { AuthorizedKeyInfo, GetKeysResponse } from '../actions/getKeys'

/**
 * Return keys for a chain using robust chain-id matching (`0x...` map key or numeric parse fallback).
 */
export function getChainKeys(keysResponse: GetKeysResponse, chainId: number): AuthorizedKeyInfo[] {
    const exactKey = `0x${chainId.toString(16)}`
    const exactMatch = keysResponse[exactKey]

    if (Array.isArray(exactMatch)) {
        return exactMatch
    }

    for (const [hexChainId, keys] of Object.entries(keysResponse)) {
        if (!Array.isArray(keys)) continue
        const parsed = Number.parseInt(hexChainId, 16)

        if (!Number.isNaN(parsed) && parsed === chainId) {
            return keys
        }
    }

    return []
}

/**
 * Find one authorized key by key hash within the chain-scoped key set.
 */
export function findAuthorizedKey(
    keysResponse: GetKeysResponse,
    chainId: number,
    keyHash: Hex,
): AuthorizedKeyInfo | undefined {
    const normalized = keyHash.toLowerCase()

    return getChainKeys(keysResponse, chainId).find(
        (entry) => entry.hash.toLowerCase() === normalized,
    )
}
