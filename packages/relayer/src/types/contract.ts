/**
 * Contract Types
 *
 * TypeScript interfaces for smart contract return types.
 * These mirror the ABI output from @towns-labs/contracts.
 */

import type { Hex } from 'viem'

/**
 * Key struct from TownsAccount.getKeys()
 *
 * Represents an authorized key registered on a TownsAccount.
 */
export interface ContractKey {
    expiry: number
    keyType: number
    isSuperAdmin: boolean
    publicKey: Hex
}
