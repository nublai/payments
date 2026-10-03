/**
 * Contract addresses for tests
 *
 * These are used for signing EIP-7702 authorizations and verifying contract state.
 * Addresses are loaded from @towns-labs/contracts, with fallback
 * to environment variables for local development.
 */

import type { Address } from 'viem'
import { getAddressesWithFallback } from '@towns-labs/contracts/deployments'

export interface TestContracts {
    townsAccount: Address
    accountProxy: Address
    orchestrator: Address
    simpleFunder: Address
    // Optional: only available in crosschain mode when env vars are set
    escrow?: Address
    simpleSettler?: Address
}

/**
 * Get contract addresses for tests
 * Uses getAddressesWithFallback to support local dev with env vars
 */
export function getTestContracts(context: string, chainId: number): TestContracts {
    const addresses = getAddressesWithFallback(context, chainId, { env: process.env })
    if (!addresses) {
        throw new Error(`No deployment found for ${context}/${chainId}`)
    }

    return {
        townsAccount: addresses.townsAccount,
        accountProxy: addresses.accountProxy,
        orchestrator: addresses.orchestrator,
        simpleFunder: addresses.simpleFunder,
        // Escrow/settler addresses from env vars (set by relayer dev.sh in crosschain mode)
        escrow: addresses.escrow,
        simpleSettler: addresses.simpleSettler,
    }
}

export function getLocalTestContracts(chainId: number): TestContracts {
    return getTestContracts('local', chainId)
}
