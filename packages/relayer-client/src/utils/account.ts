/**
 * Account utilities for EIP-7702 delegated accounts
 */

import type { Address, PublicClient } from 'viem'

const EIP7702_PREFIX = '0xef0100'

/**
 * Check if an address has an EIP-7702 delegation designator.
 * Returns true only for accounts with the 0xef0100 prefix (not regular contracts).
 */
export async function isDelegatedAccount(client: PublicClient, address: Address): Promise<boolean> {
    const code = await client.getCode({ address })
    if (!code || code === '0x') return false
    return code.startsWith(EIP7702_PREFIX)
}
