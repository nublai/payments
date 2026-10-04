/**
 * Contract Types
 *
 * TypeScript interfaces for smart contract return types.
 * These mirror the ABI output from @nubl/contracts.
 */

import type { Hex } from 'viem'

/**
 * Key struct from Account.getKeys()
 *
 * Represents an authorized key registered on an Account.
 */
export interface ContractKey {
    expiry: number
    keyType: number
    isSuperAdmin: boolean
    publicKey: Hex
}
