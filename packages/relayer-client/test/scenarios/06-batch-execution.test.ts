/**
 * Test 6: Batch Execution
 *
 * Verifies that multiple intents can be submitted as a true JSON-RPC batch,
 * resulting in a single on-chain transaction for gas efficiency.
 *
 * 1. Create multiple delegated accounts
 * 2. Sign intents for each account
 * 3. Submit all intents via JSON-RPC batch request
 * 4. Assert: All succeed, all share the same transaction hash (single on-chain tx)
 */

import { describe, it, expect } from 'vitest'
import { createWalletClient, http, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { createJsonRpcTransport, waitForBundle } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestAuthSigner, createRelayerTestClient } from '../helpers/client'

describe('Batch Execution', () => {
    const { accountProxy } = TEST_CONTRACTS

    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })
    const transport = createJsonRpcTransport(RELAYER_URL, {
        httpAuth: {
            signer: createRelayerTestAuthSigner(testChain.id),
        },
    })

    /**
     * Helper to submit multiple intents as a JSON-RPC batch
     */
    async function submitBatch(
        intents: Array<{
            context: Record<string, unknown>
            signature: string
        }>,
    ): Promise<{ success: boolean; bundleIds: string[] }> {
        if (intents.length === 0) {
            return { success: true, bundleIds: [] }
        }

        try {
            const results = await transport.requestBatch<{ id: string }>(
                intents.map((intent) => ({
                    method: 'wallet_sendPreparedCalls',
                    params: intent,
                })),
            )

            return {
                success: true,
                bundleIds: results.map((result) => result.id),
            }
        } catch {
            return { success: false, bundleIds: [] }
        }
    }

    async function createDelegatedAccountWithRetry(maxAttempts = 3) {
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('1'))

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const createResult = await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: accountProxy,
            })

            if (createResult.success) {
                return { privateKey, account, address: account.address }
            }

            if (attempt === maxAttempts) {
                expect(createResult.success).toBe(true)
            }

            await new Promise((resolve) => setTimeout(resolve, attempt * 200))
        }

        // Unreachable due to assertion above, but needed for typing.
        throw new Error('Failed to create delegated account')
    }

    it(
        'should execute multiple intents in a single on-chain transaction',
        { timeout: 60000 },
        async () => {
            // #given - Create 3 delegated accounts
            const accounts = []
            for (let i = 0; i < 3; i++) {
                accounts.push(await createDelegatedAccountWithRetry())
            }

            // Prepare and sign intents for each account (simple self-call)
            const signedIntents = await Promise.all(
                accounts.map(async (acc) => {
                    const prepared = await client.prepareCalls({
                        from: acc.address,
                        calls: [{ target: acc.address, value: 0n, data: '0x' }],
                    })

                    const walletClient = createWalletClient({
                        account: acc.account,
                        chain: testChain,
                        transport: http(ANVIL_RPC_URL),
                    })

                    const signature = await walletClient.signTypedData({
                        domain: prepared.typedData.domain,
                        types: prepared.typedData.types,
                        primaryType: prepared.typedData.primaryType,
                        message: prepared.typedData.message,
                    })

                    return { context: prepared.context, signature }
                }),
            )

            // #when - Submit all intents as a batch
            const result = await submitBatch(signedIntents)

            // #then - All should succeed
            expect(result.success).toBe(true)
            expect(result.bundleIds).toBeDefined()
            expect(result.bundleIds).toHaveLength(3)

            // Wait for all bundles to confirm
            const statuses = await Promise.all(
                result.bundleIds.map((id) => waitForBundle(client, { id })),
            )

            // All should be confirmed
            for (const status of statuses) {
                expect(status.statusCode).toBe(200)
                expect(status.receipt?.transactionHash).toBeDefined()
            }

            // Key assertion: All bundles should share the same transaction hash
            // This proves they were executed in a single on-chain transaction
            const txHashes = statuses.map((s) => s.receipt?.transactionHash)
            const uniqueTxHashes = [...new Set(txHashes)]
            expect(uniqueTxHashes).toHaveLength(1)
        },
    )

    it('should return individual bundle IDs for status tracking', { timeout: 60000 }, async () => {
        // #given - Create 2 accounts
        const accounts = []
        for (let i = 0; i < 2; i++) {
            accounts.push(await createDelegatedAccountWithRetry())
        }

        const signedIntents = await Promise.all(
            accounts.map(async (acc) => {
                const prepared = await client.prepareCalls({
                    from: acc.address,
                    calls: [{ target: acc.address, value: 0n, data: '0x' }],
                })

                const walletClient = createWalletClient({
                    account: acc.account,
                    chain: testChain,
                    transport: http(ANVIL_RPC_URL),
                })

                const signature = await walletClient.signTypedData({
                    domain: prepared.typedData.domain,
                    types: prepared.typedData.types,
                    primaryType: prepared.typedData.primaryType,
                    message: prepared.typedData.message,
                })

                return { context: prepared.context, signature }
            }),
        )

        // #when
        const result = await submitBatch(signedIntents)

        // #then - Each intent gets its own bundle ID
        expect(result.success).toBe(true)
        expect(result.bundleIds).toHaveLength(2)

        // Bundle IDs should be unique (different intents = different bundle IDs)
        const uniqueBundleIds = [...new Set(result.bundleIds)]
        expect(uniqueBundleIds).toHaveLength(2)
    })

    it('should handle empty batch gracefully', async () => {
        // #when - Submit empty batch
        const result = await submitBatch([])

        // #then - Should succeed with empty results
        expect(result.success).toBe(true)
        expect(result.bundleIds).toEqual([])
    })
})
