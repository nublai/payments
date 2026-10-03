/**
 * Test 4: Nonce Management
 *
 * Verifies nonce handling:
 * 1. Nonce increments after successful execution
 * 2. Sequential intents with correct nonces
 * 3. 2D nonce (seqKey) functionality
 */

import { describe, it, expect } from 'vitest'
import { createWalletClient, http, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { accountAbi } from '@agentic-payments/contracts/abis'

import { waitForBundle } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestClient } from '../helpers/client'

describe('Nonce Management', () => {
    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    const contracts = TEST_CONTRACTS
    const recipient = '0x000000000000000000000000000000000000dEaD'

    /**
     * Helper to get nonce from the delegated account contract
     */
    async function getNonce(accountAddress: `0x${string}`, seqKey: bigint = 0n): Promise<bigint> {
        try {
            return await client.readContract({
                address: accountAddress,
                abi: accountAbi,
                functionName: 'getNonce',
                args: [seqKey],
            })
        } catch {
            // Account might not be delegated yet, return default
            return seqKey << 64n
        }
    }

    it('should increment nonce after successful execution', { timeout: 45000 }, async () => {
        // 1. Create delegated account
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('10'))

        const createResult = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })
        expect(createResult.success).toBe(true)

        // 2. Get initial nonce
        const nonceBefore = await getNonce(account.address)
        expect(nonceBefore).toBe(0n) // Fresh account starts at 0

        // 3. Prepare, sign, and execute intent
        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [
                {
                    target: recipient,
                    value: parseEther('0.1'),
                    data: '0x',
                },
            ],
        })

        // Verify the intent was prepared with the correct nonce
        expect(prepared.typedData.message.nonce).toBe(nonceBefore)

        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        const signature = await walletClient.signTypedData({
            domain: prepared.typedData.domain,
            types: prepared.typedData.types,
            primaryType: prepared.typedData.primaryType,
            message: prepared.typedData.message,
        })

        const result = await client.sendPreparedCalls({
            context: prepared.context,
            signature,
        })
        expect(result.id).toBeDefined()

        // Wait for bundle to reach final status
        const status = await waitForBundle(client, { id: result.id })
        expect(status.statusCode).toBe(200)
        expect(status.receipt?.transactionHash).toBeDefined()

        // 4. Verify nonce incremented
        const nonceAfter = await getNonce(account.address)
        expect(nonceAfter).toBe(nonceBefore + 1n)
    })

    it('should handle sequential intents correctly', { timeout: 60000 }, async () => {
        // 1. Create delegated account
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('10'))

        await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })

        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        // 2. Execute three sequential intents
        for (let i = 0; i < 3; i++) {
            const nonceBefore = await getNonce(account.address)

            const prepared = await client.prepareCalls({
                from: account.address,
                calls: [
                    {
                        target: recipient,
                        value: parseEther('0.1'),
                        data: '0x',
                    },
                ],
            })

            expect(prepared.typedData.message.nonce).toBe(nonceBefore)

            const signature = await walletClient.signTypedData({
                domain: prepared.typedData.domain,
                types: prepared.typedData.types,
                primaryType: prepared.typedData.primaryType,
                message: prepared.typedData.message,
            })

            const result = await client.sendPreparedCalls({
                context: prepared.context,
                signature,
            })
            expect(result.id).toBeDefined()

            // Wait for transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 2000))

            const nonceAfter = await getNonce(account.address)
            expect(nonceAfter).toBe(nonceBefore + 1n)
        }

        // Final nonce should be 3
        const finalNonce = await getNonce(account.address)
        expect(finalNonce).toBe(3n)
    })

    it('should support 2D nonce with different seqKeys', { timeout: 60000 }, async () => {
        // 1. Create delegated account
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('10'))

        await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })

        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        // 2. Execute intent with seqKey 0
        const seqKey0 = 0n
        const nonce0Before = await getNonce(account.address, seqKey0)

        const prepared0 = await client.prepareCalls({
            from: account.address,
            calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
            seqKey: seqKey0,
        })

        const signature0 = await walletClient.signTypedData({
            domain: prepared0.typedData.domain,
            types: prepared0.typedData.types,
            primaryType: prepared0.typedData.primaryType,
            message: prepared0.typedData.message,
        })

        const result0 = await client.sendPreparedCalls({
            context: prepared0.context,
            signature: signature0,
        })
        expect(result0.id).toBeDefined()

        // Wait for bundle to reach final status
        const status0 = await waitForBundle(client, { id: result0.id })
        expect(status0.statusCode).toBe(200)

        // 3. Execute intent with seqKey 1 (different sequence)
        const seqKey1 = 1n
        const nonce1Before = await getNonce(account.address, seqKey1)

        // seqKey 1 should start at (1 << 64) | 0
        expect(nonce1Before).toBe(seqKey1 << 64n)

        const prepared1 = await client.prepareCalls({
            from: account.address,
            calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
            seqKey: seqKey1,
        })

        const signature1 = await walletClient.signTypedData({
            domain: prepared1.typedData.domain,
            types: prepared1.typedData.types,
            primaryType: prepared1.typedData.primaryType,
            message: prepared1.typedData.message,
        })

        const result1 = await client.sendPreparedCalls({
            context: prepared1.context,
            signature: signature1,
        })
        expect(result1.id).toBeDefined()

        // Wait for bundle to reach final status
        const status1 = await waitForBundle(client, { id: result1.id })
        expect(status1.statusCode).toBe(200)

        // 4. Verify both nonces incremented independently
        const nonce0After = await getNonce(account.address, seqKey0)
        const nonce1After = await getNonce(account.address, seqKey1)

        expect(nonce0After).toBe(nonce0Before + 1n)
        expect(nonce1After).toBe(nonce1Before + 1n)

        // Nonces should be in different "lanes"
        expect(nonce0After).toBe(1n) // seqKey 0: just the counter
        expect(nonce1After).toBe((seqKey1 << 64n) + 1n) // seqKey 1: (1 << 64) + 1
    })

    it(
        'should default to latest on-chain nonce when noncePolicy is omitted',
        { timeout: 60000 },
        async () => {
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)
            await setBalance(account.address, parseEther('10'))

            await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })

            const onChainNonceBefore = await getNonce(account.address, 0n)
            expect(onChainNonceBefore).toBe(0n)

            const first = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.01'), data: '0x' }],
            })
            const second = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.02'), data: '0x' }],
            })

            expect(first.typedData.message.nonce).toBe(onChainNonceBefore)
            expect(second.typedData.message.nonce).toBe(onChainNonceBefore)

            // Default behavior should not create draft metadata when using latest on-chain nonce.
            expect(first.context.draft).toBeUndefined()
            expect(second.context.draft).toBeUndefined()
        },
    )

    it(
        'should replay draft for repeated prepare on seqKey=0 without prepareKey and allow only one successful send',
        { timeout: 60000 },
        async () => {
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)
            await setBalance(account.address, parseEther('10'))

            await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })

            const walletClient = createWalletClient({
                account,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            const initialNonce = await getNonce(account.address, 0n)
            expect(initialNonce).toBe(0n)

            const first = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.01'), data: '0x' }],
                seqKey: 0n,
                noncePolicy: 'draft',
            })
            const second = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.01'), data: '0x' }],
                seqKey: 0n,
                noncePolicy: 'draft',
            })

            expect(second.typedData.message.nonce).toBe(first.typedData.message.nonce)
            expect(second.context.draft?.id).toBe(first.context.draft?.id)
            expect(second.context.draft?.fromCache).toBe(true)

            const firstSignature = await walletClient.signTypedData({
                domain: first.typedData.domain,
                types: first.typedData.types,
                primaryType: first.typedData.primaryType,
                message: first.typedData.message,
            })
            const secondSignature = await walletClient.signTypedData({
                domain: second.typedData.domain,
                types: second.typedData.types,
                primaryType: second.typedData.primaryType,
                message: second.typedData.message,
            })

            const [firstSend, secondSend] = await Promise.all([
                client.sendPreparedCalls({
                    context: first.context,
                    signature: firstSignature,
                }),
                client.sendPreparedCalls({
                    context: second.context,
                    signature: secondSignature,
                }),
            ])

            const [firstStatus, secondStatus] = await Promise.all([
                waitForBundle(client, { id: firstSend.id }),
                waitForBundle(client, { id: secondSend.id }),
            ])

            const statuses = [firstStatus, secondStatus]
            const successStatuses = statuses.filter((status) => status.statusCode === 200)
            expect(successStatuses.length).toBeGreaterThanOrEqual(1)
            expect(successStatuses.length).toBeLessThanOrEqual(2)

            if (successStatuses.length === 2) {
                expect(successStatuses[0].receipt?.transactionHash).toBeDefined()
                expect(successStatuses[1].receipt?.transactionHash).toBeDefined()
                expect(successStatuses[1].receipt?.transactionHash).toBe(
                    successStatuses[0].receipt?.transactionHash,
                )
            }

            const nonceAfter = await getNonce(account.address, 0n)
            expect(nonceAfter).toBe(1n)
        },
    )

    it(
        'should handle truly parallel intents with different seqKeys',
        { timeout: 60000 },
        async () => {
            // This test verifies that multiple intents can be prepared and submitted
            // in parallel using different seqKeys (2D nonce lanes).

            // 1. Create delegated account
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)
            await setBalance(account.address, parseEther('10'))

            await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })

            const walletClient = createWalletClient({
                account,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            // 2. Prepare multiple intents in parallel with different seqKeys
            const seqKeys = [0n, 1n, 2n]
            const preparedIntents = await Promise.all(
                seqKeys.map((seqKey) =>
                    client.prepareCalls({
                        from: account.address,
                        calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
                        seqKey,
                    }),
                ),
            )

            // Each should have nonce 0 in their respective lanes
            expect(preparedIntents[0].typedData.message.nonce).toBe(0n) // seqKey 0, seq 0
            expect(preparedIntents[1].typedData.message.nonce).toBe(1n << 64n) // seqKey 1, seq 0
            expect(preparedIntents[2].typedData.message.nonce).toBe(2n << 64n) // seqKey 2, seq 0

            // 3. Sign all intents
            const signatures = await Promise.all(
                preparedIntents.map((prepared) =>
                    walletClient.signTypedData({
                        domain: prepared.typedData.domain,
                        types: prepared.typedData.types,
                        primaryType: prepared.typedData.primaryType,
                        message: prepared.typedData.message,
                    }),
                ),
            )

            // 4. Submit all intents in parallel (no waiting between)
            const submitResults = await Promise.all(
                preparedIntents.map((prepared, i) =>
                    client.sendPreparedCalls({
                        context: prepared.context,
                        signature: signatures[i],
                    }),
                ),
            )

            // All should succeed
            for (const result of submitResults) {
                expect(result.id).toBeDefined()
            }

            // 5. Wait for all bundles to confirm
            const statuses = await Promise.all(
                submitResults.map((result) => waitForBundle(client, { id: result.id })),
            )

            // All should succeed
            for (const status of statuses) {
                expect(status.statusCode).toBe(200)
            }

            // 6. Verify all nonces incremented in their respective lanes
            for (const seqKey of seqKeys) {
                const nonce = await getNonce(account.address, seqKey)
                expect(nonce).toBe((seqKey << 64n) + 1n)
            }
        },
    )

    it(
        'should replay same draft on repeated prepare with same prepareKey (seqKey=0)',
        { timeout: 60000 },
        async () => {
            // Idempotent prepare behavior:
            // repeated prepare on the same lane with the same prepareKey should replay the pending draft.

            // 1. Create delegated account
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)
            await setBalance(account.address, parseEther('10'))

            await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })

            // 2. Verify initial on-chain nonce is 0
            const initialNonce = await getNonce(account.address)
            expect(initialNonce).toBe(0n)

            // 3. Prepare once, but do not submit
            const first = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.01'), data: '0x' }],
                prepareKey: 'same-key',
                noncePolicy: 'draft',
            })
            const firstNonce = first.typedData.message.nonce
            expect(first.context.draft?.id).toBeDefined()
            expect(first.context.draft?.fromCache).toBe(false)

            // 4. On-chain nonce is still 0 (nothing was submitted)
            const nonceAfterDrift = await getNonce(account.address)
            expect(nonceAfterDrift).toBe(0n)

            // 5. Prepare again on the same lane with the same prepareKey.
            // It should return the same draft + nonce from cache.
            const second = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
                prepareKey: 'same-key',
                noncePolicy: 'draft',
            })
            expect(second.context.draft?.id).toBe(first.context.draft?.id)
            expect(second.context.draft?.fromCache).toBe(true)
            expect(second.typedData.message.nonce).toBe(firstNonce)

            // 6. Verify on-chain nonce remains unchanged
            const finalNonce = await getNonce(account.address)
            expect(finalNonce).toBe(0n)
        },
    )

    it(
        'should replay same draft on repeated prepare with same prepareKey (non-zero seqKey)',
        { timeout: 60000 },
        async () => {
            // Same replay behavior should hold for non-zero seqKey lanes.

            // 1. Create delegated account
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)
            await setBalance(account.address, parseEther('10'))

            await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })

            const seqKey = 1n // Non-zero seqKey

            // 2. Verify initial on-chain nonce for seqKey=1
            const initialNonce = await getNonce(account.address, seqKey)
            expect(initialNonce).toBe(seqKey << 64n) // (1 << 64) | 0

            // 3. Prepare once, but do not submit
            const first = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.01'), data: '0x' }],
                seqKey,
                prepareKey: 'same-lane-key',
                noncePolicy: 'draft',
            })
            expect(first.context.draft?.id).toBeDefined()
            expect(first.context.draft?.fromCache).toBe(false)

            // 4. On-chain nonce is still at seq=0 (nothing was submitted)
            const nonceAfterDrift = await getNonce(account.address, seqKey)
            expect(nonceAfterDrift).toBe(seqKey << 64n) // Still (1 << 64) | 0

            // 5. Re-prepare in the same lane with the same prepareKey and verify replay.
            const second = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
                seqKey,
                prepareKey: 'same-lane-key',
                noncePolicy: 'draft',
            })
            expect(second.context.draft?.id).toBe(first.context.draft?.id)
            expect(second.context.draft?.fromCache).toBe(true)
            expect(second.typedData.message.nonce).toBe(first.typedData.message.nonce)

            // 6. Verify on-chain nonce remains unchanged for this seqKey lane
            const finalNonce = await getNonce(account.address, seqKey)
            expect(finalNonce).toBe(seqKey << 64n) // Still (1 << 64) | 0
        },
    )

    it(
        'should reject prepare with different prepareKey when draft is active (seqKey=0)',
        { timeout: 60000 },
        async () => {
            // Conflict behavior:
            // preparing on the same lane with a different prepareKey while a draft is active
            // should fail with a draft conflict error.

            // 1. Create delegated account
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)
            await setBalance(account.address, parseEther('10'))

            await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })

            // 2. Prepare once, creating an active draft
            const first = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.01'), data: '0x' }],
                prepareKey: 'first-key',
                noncePolicy: 'draft',
            })
            expect(first.context.draft?.id).toBeDefined()
            expect(first.context.draft?.fromCache).toBe(false)

            // 3. Prepare again with a different prepareKey — should be rejected
            await expect(
                client.prepareCalls({
                    from: account.address,
                    calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
                    prepareKey: 'second-key',
                    noncePolicy: 'draft',
                }),
            ).rejects.toThrow(/[Dd]raft conflict|different draftKey/)

            // 4. On-chain nonce remains unchanged
            const finalNonce = await getNonce(account.address)
            expect(finalNonce).toBe(0n)
        },
    )

    it(
        'should reject prepare with different prepareKey when draft is active (non-zero seqKey)',
        { timeout: 60000 },
        async () => {
            // Same conflict behavior for non-zero seqKey lanes.

            // 1. Create delegated account
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)
            await setBalance(account.address, parseEther('10'))

            await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })

            const seqKey = 1n

            // 2. Prepare once, creating an active draft on seqKey=1
            const first = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.01'), data: '0x' }],
                seqKey,
                prepareKey: 'lane-one',
                noncePolicy: 'draft',
            })
            expect(first.context.draft?.id).toBeDefined()
            expect(first.context.draft?.fromCache).toBe(false)

            // 3. Prepare again with a different prepareKey — should be rejected
            await expect(
                client.prepareCalls({
                    from: account.address,
                    calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
                    seqKey,
                    prepareKey: 'lane-two',
                    noncePolicy: 'draft',
                }),
            ).rejects.toThrow(/[Dd]raft conflict|different draftKey/)

            // 4. On-chain nonce remains unchanged
            const finalNonce = await getNonce(account.address, seqKey)
            expect(finalNonce).toBe(seqKey << 64n)
        },
    )

    it('should reject intent with wrong nonce', { timeout: 30000 }, async () => {
        // 1. Create delegated account
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('10'))

        await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })

        // 2. Attempting to prepare intent with wrong nonce should fail at preparation
        // The relayer simulates the intent and rejects invalid nonces
        await expect(
            client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
                nonce: 999n, // Wrong nonce - chain expects 0
            }),
        ).rejects.toThrow(/Simulation failed/)
    })
})
