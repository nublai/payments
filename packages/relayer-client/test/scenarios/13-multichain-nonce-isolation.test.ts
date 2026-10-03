/**
 * Test 13: Multichain Nonce Isolation
 *
 * Verifies nonces are isolated per-chain for the same delegated EOA.
 */

import { describe, expect, it } from 'vitest'
import { parseEther, type Address } from 'viem'
import { accountAbi } from '@agentic-payments/contracts/abis'

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
import { prepareSignSendAndWait } from '../helpers/intent'
import { setBalance } from '../helpers/anvil'

describe('Multichain Nonce Isolation', () => {
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

    async function getNonce(
        client: typeof primaryClient,
        accountAddress: Address,
        seqKey: bigint = 0n,
    ): Promise<bigint> {
        return client.readContract({
            address: accountAddress,
            abi: accountAbi,
            functionName: 'getNonce',
            args: [seqKey],
        })
    }

    it('increments nonce on one chain without changing the other', { timeout: 90000 }, async () => {
        const { account, privateKey } = createEphemeralAccount()
        const recipient = '0x000000000000000000000000000000000000dEaD'

        await setBalance(account.address, parseEther('1'))
        await setBalanceOnChain({
            address: account.address,
            amount: parseEther('1'),
            rpcUrl: ANVIL_RPC_URL_ARB,
            chain: outputChain,
        })

        const { primaryResult, secondaryResult } = await delegateOnBothChains({
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
        expect(secondaryResult.success).toBe(true)

        const noncePrimaryStart = await getNonce(primaryClient, account.address)
        const nonceSecondaryStart = await getNonce(secondaryClient, account.address)
        expect(noncePrimaryStart).toBe(0n)
        expect(nonceSecondaryStart).toBe(0n)

        const primaryExecution = await prepareSignSendAndWait({
            client: primaryClient,
            chain: testChain,
            rpcUrl: ANVIL_RPC_URL,
            privateKey,
            prepare: {
                from: account.address,
                chainId: testChain.id,
                calls: [{ target: recipient, value: 0n, data: '0x' }],
            },
        })
        expect(primaryExecution.status.statusCode).toBe(200)

        const noncePrimaryAfterFirst = await getNonce(primaryClient, account.address)
        const nonceSecondaryAfterFirst = await getNonce(secondaryClient, account.address)
        expect(noncePrimaryAfterFirst).toBe(1n)
        expect(nonceSecondaryAfterFirst).toBe(0n)

        const secondaryExecution = await prepareSignSendAndWait({
            client: secondaryClient,
            chain: outputChain,
            rpcUrl: ANVIL_RPC_URL_ARB,
            privateKey,
            prepare: {
                from: account.address,
                chainId: outputChain.id,
                calls: [{ target: recipient, value: 0n, data: '0x' }],
            },
        })
        expect(secondaryExecution.status.statusCode).toBe(200)

        const noncePrimaryFinal = await getNonce(primaryClient, account.address)
        const nonceSecondaryFinal = await getNonce(secondaryClient, account.address)
        expect(noncePrimaryFinal).toBe(1n)
        expect(nonceSecondaryFinal).toBe(1n)
    })

    it(
        'uses target-chain nonce when prepareCalls overrides chainId from a different connected client chain',
        { timeout: 90000 },
        async () => {
            const { account, privateKey } = createEphemeralAccount()
            const recipient = '0x000000000000000000000000000000000000dEaD'

            await setBalance(account.address, parseEther('1'))
            await setBalanceOnChain({
                address: account.address,
                amount: parseEther('1'),
                rpcUrl: ANVIL_RPC_URL_ARB,
                chain: outputChain,
            })

            const { primaryResult, secondaryResult } = await delegateOnBothChains({
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
            expect(secondaryResult.success).toBe(true)

            // Move primary chain nonce forward while secondary stays at 0.
            const primaryExecution = await prepareSignSendAndWait({
                client: primaryClient,
                chain: testChain,
                rpcUrl: ANVIL_RPC_URL,
                privateKey,
                prepare: {
                    from: account.address,
                    chainId: testChain.id,
                    calls: [{ target: recipient, value: 0n, data: '0x' }],
                },
            })
            expect(primaryExecution.status.statusCode).toBe(200)

            const noncePrimary = await getNonce(primaryClient, account.address)
            const nonceSecondary = await getNonce(secondaryClient, account.address)
            expect(noncePrimary).toBe(1n)
            expect(nonceSecondary).toBe(0n)

            // Prepare from the primary client but target secondary chain via chainId override.
            const preparedOnSecondary = await primaryClient.prepareCalls({
                from: account.address,
                chainId: outputChain.id,
                calls: [{ target: recipient, value: 0n, data: '0x' }],
            })

            expect(preparedOnSecondary.typedData.message.nonce).toBe(0n)
        },
    )
})
