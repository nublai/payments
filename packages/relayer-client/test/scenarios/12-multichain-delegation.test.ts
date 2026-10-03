/**
 * Test 12: Multichain Delegation
 *
 * Verifies the same EOA can be delegated on both local chains independently.
 */

import { describe, expect, it } from 'vitest'
import { parseEther } from 'viem'

import {
    ANVIL_RPC_URL,
    ANVIL_RPC_URL_ARB,
    OUTPUT_CHAIN_ID,
    TEST_CONTRACTS,
    outputChain,
    testChain,
} from '../setup'
import { createRelayerTestClient } from '../helpers/client'
import { createEphemeralAccount } from '../helpers/account'
import { getLocalTestContracts } from '../helpers/deployments'
import { delegateOnBothChains, setBalanceOnChain } from '../helpers/multichain'
import { setBalance } from '../helpers/anvil'

describe('Multichain Delegation', () => {
    const primaryClient = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
    })
    const secondaryClient = createRelayerTestClient({
        chain: outputChain,
        rpcUrl: ANVIL_RPC_URL_ARB,
    })

    const primaryContracts = TEST_CONTRACTS
    const secondaryContracts = getLocalTestContracts(OUTPUT_CHAIN_ID)

    it('delegates one EOA on both chains', { timeout: 60000 }, async () => {
        const { account, privateKey } = createEphemeralAccount()

        await setBalance(account.address, parseEther('1'))
        await setBalanceOnChain({
            address: account.address,
            amount: parseEther('1'),
            rpcUrl: ANVIL_RPC_URL_ARB,
            chain: outputChain,
        })

        const codePrimaryBefore = await primaryClient.getCode({ address: account.address })
        const codeSecondaryBefore = await secondaryClient.getCode({ address: account.address })
        expect(codePrimaryBefore === undefined || codePrimaryBefore === '0x').toBe(true)
        expect(codeSecondaryBefore === undefined || codeSecondaryBefore === '0x').toBe(true)

        const { primaryResult } = await delegateOnBothChains({
            accountAddress: account.address,
            privateKey,
            primaryClient,
            secondaryClient,
            primaryDelegation: primaryContracts.accountProxy,
            secondaryDelegation: secondaryContracts.accountProxy,
            primaryChainId: testChain.id,
            secondaryChainId: outputChain.id,
        })
        expect(primaryResult.success).toBe(true)
        expect(primaryResult.txHash).toBeDefined()

        const codePrimaryAfter = await primaryClient.getCode({ address: account.address })
        expect(codePrimaryAfter?.startsWith('0xef0100')).toBe(true)

        const codeSecondaryAfter = await secondaryClient.getCode({ address: account.address })
        expect(codeSecondaryAfter?.startsWith('0xef0100')).toBe(true)
    })
})
