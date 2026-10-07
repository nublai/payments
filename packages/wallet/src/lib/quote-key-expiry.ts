import { encodeFunctionData, type Address, type Hex } from 'viem'
import { INTENT_EXPIRY_TTL_SECONDS, type Call } from '@nubl/relayer-client'
import { accountAbi } from '@nubl/contracts/abis'

/**
 * Account.Key.expiry already exists (0 = never). Orchestrator intent expiry
 * does not clear canExecute or a minute spend limit. The quote installer sets
 * this key's expiry so a dead process cannot keep the approve grant forever.
 *
 * The key has to stay valid through an intent signed after install, so the
 * window is two intent TTLs (2 hours). Recovery writes the previous expiry
 * back. If recovery never runs, the key stops signing when this expiry passes.
 * The grant and the minute limit remain in storage and cannot be used.
 *
 * No new storage, no bytecode change, no redeploy. The root key sends the
 * existing `authorize` call, which updates expiry when the key already exists.
 */
export const QUOTE_KEY_EXPIRY_SECONDS = INTENT_EXPIRY_TTL_SECONDS * 2n

export type QuoteKeyMaterial = {
    expiry: bigint
    keyType: number
    isSuperAdmin: boolean
    publicKey: Hex
}

export type QuoteKeyExpiryPlan = {
    previous: bigint
    installed: bigint
    changed: boolean
}

/** A sooner non-zero expiry is left alone. Zero means the key never expires. */
export function planQuoteKeyExpiry(input: {
    now: bigint
    currentExpiry: bigint
}): QuoteKeyExpiryPlan {
    const installed = input.now + QUOTE_KEY_EXPIRY_SECONDS
    if (installed > 2n ** 40n - 1n) {
        throw new Error('Quote key expiry does not fit in uint40.')
    }
    if (input.currentExpiry !== 0n && input.currentExpiry <= installed) {
        return { previous: input.currentExpiry, installed: input.currentExpiry, changed: false }
    }
    return { previous: input.currentExpiry, installed, changed: true }
}

/**
 * Restores the previous expiry only while the key still exists.
 * `authorize` on a missing key would create it again and revive canExecute.
 */
export function restoreQuoteKeyExpiryCall(input: {
    account: Address
    previous: QuoteKeyMaterial | undefined
    keyStillExists: boolean
}): Call[] {
    if (!input.previous || !input.keyStillExists) return []
    return [
        authorizeKeyExpiryCall({
            account: input.account,
            key: input.previous,
            expiry: input.previous.expiry,
        }),
    ]
}

export function authorizeKeyExpiryCall(input: {
    account: Address
    key: QuoteKeyMaterial
    expiry: bigint
}): Call {
    return {
        target: input.account,
        value: 0n,
        data: encodeFunctionData({
            abi: accountAbi,
            functionName: 'authorize',
            args: [
                {
                    expiry: Number(input.expiry),
                    keyType: input.key.keyType,
                    isSuperAdmin: input.key.isSuperAdmin,
                    publicKey: input.key.publicKey,
                },
            ],
        }),
    }
}
