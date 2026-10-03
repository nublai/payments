/**
 * Test 1: Account Delegation
 *
 * Verifies the end-to-end flow of creating a delegated EIP-7702 account:
 * 1. Generate EOA keypair
 * 2. Upgrade EOA to delegated account via relayer (two-step flow with two signatures)
 * 3. Verify delegation (check code, owner)
 */

import { describe, it, expect } from 'vitest'
import { createWalletClient, http, encodeAbiParameters, parseEther, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { accountAbi } from '@agentic-payments/contracts/abis'

import {
    waitForBundle,
    wrapSignature,
    computeKeyHash,
    decodeIntentError,
    ANY_TARGET,
    EMPTY_CALLDATA_SELECTOR,
} from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CHAIN_ID, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestClient } from '../helpers/client'

describe('Account Delegation', () => {
    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    // Contract addresses for the current chain
    const contracts = TEST_CONTRACTS

    it('should check relayer health', async () => {
        const health = await client.checkHealth()
        expect(health.status).toBe('ok')
        expect(health.chainId).toBe(TEST_CHAIN_ID)
    })

    it('should get relayer capabilities', async () => {
        const caps = await client.getCapabilities()
        expect(caps.success).toBe(true)
        expect(caps.capabilities?.accountCreation).toBe(true)
        expect(caps.capabilities?.intentExecution).toBe(true)
    })

    it('should create a delegated account', async () => {
        // 1. Generate a new keypair
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)

        // 2. Fund the account with some ETH (for initial setup if needed)
        await setBalance(account.address, parseEther('1')) // 1 ETH

        // 3. Verify no code before delegation
        const codeBefore = await client.getCode({ address: account.address })
        expect(codeBefore === undefined || codeBefore === '0x').toBe(true)

        // 4. Upgrade account via relayer (two-step flow with two signatures)
        const result = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })

        expect(result.success).toBe(true)
        expect(result.accountAddress).toBe(account.address)
        expect(result.txHash).toBeDefined()

        // 5. Verify EIP-7702 delegation code is present (relayer waits for confirmation)
        const codeAfter = await client.getCode({ address: account.address })
        expect(codeAfter).toBeDefined()
        expect(codeAfter !== '0x').toBe(true)
        expect(codeAfter?.startsWith('0xef0100')).toBe(true) // EIP-7702 delegation designator

        // 7. Verify the account is functional by checking we can read contract state
        // Note: In the new Account design, the EOA's native key is implicitly authorized
        // via ECDSA recovery - it doesn't need to be stored as an explicit key.
        // keyCount() will be 0 until session keys are explicitly added.
        const keyCount = await client.readContract({
            address: account.address,
            abi: accountAbi,
            functionName: 'keyCount',
        })
        // Initially no explicit keys - the EOA key is implicit
        expect(keyCount).toBe(0n)

        // 8. Verify the contract responds correctly (delegation worked)
        const label = await client.readContract({
            address: account.address,
            abi: accountAbi,
            functionName: 'label',
        })
        // Label starts empty
        expect(label).toBe('')
    })

    it('should create a delegated account with a wallet client', async () => {
        // 1. Generate a new keypair
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)

        // 2. Fund the account with some ETH
        await setBalance(account.address, parseEther('1')) // 1 ETH

        // 3. Create wallet client with the account
        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        // 4. Verify no code before delegation
        const codeBefore = await client.getCode({ address: account.address })
        expect(codeBefore === undefined || codeBefore === '0x').toBe(true)

        // 5. Upgrade account via relayer using wallet client (two-step flow with two signatures)
        const result = await client.upgradeAccount({
            accountAddress: account.address,
            walletClient,
            delegation: contracts.accountProxy,
        })

        expect(result.success).toBe(true)
        expect(result.accountAddress).toBe(account.address)
        expect(result.txHash).toBeDefined()

        // 6. Verify EIP-7702 delegation code is present (relayer waits for confirmation)
        const codeAfter = await client.getCode({ address: account.address })
        expect(codeAfter).toBeDefined()
        expect(codeAfter !== '0x').toBe(true)
        expect(codeAfter?.startsWith('0xef0100')).toBe(true) // EIP-7702 delegation designator

        // 8. Verify the account is functional by checking we can read contract state
        const keyCount = await client.readContract({
            address: account.address,
            abi: accountAbi,
            functionName: 'keyCount',
        })
        // Initially no explicit keys - the EOA key is implicit
        expect(keyCount).toBe(0n)

        // 9. Verify the contract responds correctly (delegation worked)
        const label = await client.readContract({
            address: account.address,
            abi: accountAbi,
            functionName: 'label',
        })
        // Label starts empty
        expect(label).toBe('')
    })

    it(
        'should create a delegated account with authorized keys that can execute',
        { timeout: 30000 },
        async () => {
            // 1. Generate owner keypair
            const ownerPrivateKey = generatePrivateKey()
            const ownerAccount = privateKeyToAccount(ownerPrivateKey)

            // 2. Generate an additional key to authorize during upgrade
            const additionalPrivateKey = generatePrivateKey()
            const additionalAccount = privateKeyToAccount(additionalPrivateKey)

            // 3. Fund the owner account
            await setBalance(ownerAccount.address, parseEther('1')) // 1 ETH

            // 4. Verify no code before delegation
            const codeBefore = await client.getCode({ address: ownerAccount.address })
            expect(codeBefore === undefined || codeBefore === '0x').toBe(true)

            // 5. Upgrade account with authorizeKeys - admin key can execute anything
            // Note: For secp256k1 keys, publicKey must be ABI-encoded address (32 bytes)
            // The contract uses abi.decode(key.publicKey, (address)) to extract it
            const encodedPublicKey = encodeAbiParameters(
                [{ type: 'address' }],
                [additionalAccount.address],
            )

            const result = await client.upgradeAccount({
                accountAddress: ownerAccount.address,
                signerKey: ownerPrivateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0', // Never expires
                        type: 'secp256k1',
                        role: 'admin', // Super admin - can execute anything
                        publicKey: encodedPublicKey,
                        permissions: [], // Admin doesn't need explicit permissions
                    },
                ],
            })

            expect(result.success).toBe(true)
            expect(result.accountAddress).toBe(ownerAccount.address)
            expect(result.txHash).toBeDefined()

            // 6. Verify EIP-7702 delegation code is present (relayer waits for confirmation)
            const codeAfter = await client.getCode({ address: ownerAccount.address })
            expect(codeAfter?.startsWith('0xef0100')).toBe(true)

            // 8. Verify the additional key was authorized
            const keyCount = await client.readContract({
                address: ownerAccount.address,
                abi: accountAbi,
                functionName: 'keyCount',
            })
            expect(keyCount).toBe(1n)

            // 9. Verify the key details via getKeys()
            const keysResult = await client.readContract({
                address: ownerAccount.address,
                abi: accountAbi,
                functionName: 'getKeys',
            })
            const keys = keysResult[0]
            const keyHashes = keysResult[1]

            expect(keys.length).toBe(1)
            expect(keys[0].isSuperAdmin).toBe(true) // admin role
            expect(keys[0].keyType).toBe(0) // Secp256k1

            // Verify our keyHash computation matches the contract's
            const computedKeyHash = computeKeyHash('secp256k1', encodedPublicKey)
            expect(computedKeyHash).toBe(keyHashes[0])

            // 10. Use the ADDITIONAL key (not owner) to sign and execute an ETH transfer
            const recipient = '0x000000000000000000000000000000000000dEaD'
            const transferAmount = parseEther('0.1') // 0.1 ETH

            const balanceBefore = await client.getBalance({ address: ownerAccount.address })

            // Compute the keyHash for the authorized key
            const keyHash = computeKeyHash('secp256k1', encodedPublicKey)

            // Create wallet client for signing
            const additionalWallet = createWalletClient({
                account: additionalAccount,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            // Prepare calls
            const prepared = await client.prepareCalls({
                from: ownerAccount.address,
                calls: [{ target: recipient, value: transferAmount, data: '0x' }],
            })

            // Sign with the additional authorized key
            const rawSignature = await additionalWallet.signTypedData({
                domain: prepared.typedData.domain,
                types: prepared.typedData.types,
                primaryType: prepared.typedData.primaryType,
                message: prepared.typedData.message,
            })

            // Wrap signature with keyHash for authorized key verification
            const signature = wrapSignature(rawSignature, keyHash)

            // Send prepared calls
            const submitResult = await client.sendPreparedCalls({
                context: prepared.context,
                signature,
            })
            expect(submitResult.id).toBeDefined()

            // 11. Wait for confirmation
            const status = await waitForBundle(client, { id: submitResult.id })
            expect(status.statusCode).toBe(200)
            expect(status.receipt?.transactionHash).toBeDefined()

            // 12. Verify the transfer happened - proves the authorized key worked
            const balanceAfter = await client.getBalance({ address: ownerAccount.address })
            expect(balanceAfter).toBe(balanceBefore - transferAmount)
        },
    )

    it('should handle already delegated accounts', { timeout: 15000 }, async () => {
        // Generate and delegate first
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('1'))

        // First creation should succeed
        const result1 = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })
        expect(result1.success).toBe(true)
        expect(result1.txHash).toBeDefined()

        // Second attempt with same account (relayer waits for confirmation, so delegation is already active)
        // The behavior depends on relayer implementation:
        // - May succeed as a no-op
        // - May fail with custom error (AlreadyDelegated or similar)
        const result2 = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })

        // Either success (no-op) or error is acceptable
        // The contract may revert with AlreadyDelegated custom error
        if (!result2.success) {
            expect(result2.error).toBeDefined()
            // Custom error 0x0dc149f0 is AlreadyDelegated
            expect(
                result2.error!.includes('already') ||
                    result2.error!.includes('0x0dc149f0') ||
                    result2.error!.includes('reverted'),
            ).toBe(true)
        }
    })

    it(
        'should create a delegated account with a normal key with spend permissions',
        { timeout: 60000 },
        async () => {
            // This test demonstrates:
            // 1. Creating a delegated account with a normal (non-admin) key
            // 2. The key is granted a spend limit for native ETH during account creation
            // 3. Testing that the key CAN spend within the limit
            // 4. Testing that the key CANNOT spend more than the limit

            // 1. Generate owner keypair
            const ownerPrivateKey = generatePrivateKey()
            const ownerAccount = privateKeyToAccount(ownerPrivateKey)

            // 2. Generate a session key (non-admin)
            const sessionPrivateKey = generatePrivateKey()
            const sessionAccount = privateKeyToAccount(sessionPrivateKey)

            // 3. Fund the owner account
            await setBalance(ownerAccount.address, parseEther('1'))

            // 4. Create the delegated account with a normal key AND spend permission
            // Grant a spend limit of 0.05 ETH per day for native ETH
            const spendLimit = parseEther('0.05')

            const encodedSessionPublicKey = encodeAbiParameters(
                [{ type: 'address' }],
                [sessionAccount.address],
            )

            const result = await client.upgradeAccount({
                accountAddress: ownerAccount.address,
                signerKey: ownerPrivateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0', // Never expires
                        type: 'secp256k1',
                        role: 'normal', // NOT admin - requires explicit permissions
                        publicKey: encodedSessionPublicKey,
                        permissions: [
                            {
                                type: 'spend',
                                token: zeroAddress, // Native ETH
                                limit: spendLimit.toString(),
                                period: 'day',
                            },
                            {
                                // Allow sending ETH (empty calldata) to any target
                                type: 'call',
                                to: ANY_TARGET,
                                selector: EMPTY_CALLDATA_SELECTOR,
                            },
                        ],
                    },
                ],
            })

            if (!result.success) {
                console.error('upgradeAccount failed:', result.error)
            }
            expect(result.success).toBe(true)

            // Compute the keyHash for the session key
            const sessionKeyHash = computeKeyHash('secp256k1', encodedSessionPublicKey)

            // 6. Verify delegation and key
            const codeAfter = await client.getCode({ address: ownerAccount.address })
            expect(codeAfter?.startsWith('0xef0100')).toBe(true)

            const keyCount = await client.readContract({
                address: ownerAccount.address,
                abi: accountAbi,
                functionName: 'keyCount',
            })
            expect(keyCount).toBe(1n)

            // 7. Test that the session key CAN spend within the limit
            const recipient = '0x000000000000000000000000000000000000dEaD'
            const allowedAmount = parseEther('0.02') // Within 0.05 limit

            const balanceBefore = await client.getBalance({ address: ownerAccount.address })

            // Create wallet client for session key
            const sessionWallet = createWalletClient({
                account: sessionAccount,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            // Prepare calls
            const allowedPrepared = await client.prepareCalls({
                from: ownerAccount.address,
                calls: [{ target: recipient, value: allowedAmount, data: '0x' }],
            })

            // Sign with session key
            const allowedRawSignature = await sessionWallet.signTypedData({
                domain: allowedPrepared.typedData.domain,
                types: allowedPrepared.typedData.types,
                primaryType: allowedPrepared.typedData.primaryType,
                message: allowedPrepared.typedData.message,
            })
            const allowedSignature = wrapSignature(allowedRawSignature, sessionKeyHash)

            const allowedResult = await client.sendPreparedCalls({
                context: allowedPrepared.context,
                signature: allowedSignature,
            })
            expect(allowedResult.id).toBeDefined()

            // Wait for confirmation
            const allowedStatus = await waitForBundle(client, { id: allowedResult.id })
            expect(allowedStatus.statusCode).toBe(200)
            expect(allowedStatus.receipt?.status).toBe('success')

            // Verify the transfer happened
            const balanceAfter = await client.getBalance({ address: ownerAccount.address })
            expect(balanceAfter).toBe(balanceBefore - allowedAmount)

            // 8. Test that the session key CANNOT exceed the spend limit
            // Try to spend 0.04 ETH more (total would be 0.06, exceeding 0.05 limit)
            const excessAmount = parseEther('0.04')

            const excessPrepared = await client.prepareCalls({
                from: ownerAccount.address,
                calls: [{ target: recipient, value: excessAmount, data: '0x' }],
            })

            const excessRawSignature = await sessionWallet.signTypedData({
                domain: excessPrepared.typedData.domain,
                types: excessPrepared.typedData.types,
                primaryType: excessPrepared.typedData.primaryType,
                message: excessPrepared.typedData.message,
            })
            const excessSignature = wrapSignature(excessRawSignature, sessionKeyHash)

            const excessResult = await client.sendPreparedCalls({
                context: excessPrepared.context,
                signature: excessSignature,
            })

            // The intent may be submitted and transaction succeeds, but the inner call should fail
            if (excessResult.id) {
                const excessStatus = await waitForBundle(client, { id: excessResult.id })

                // The Orchestrator doesn't revert the tx, it returns an error code in IntentExecuted event
                // Status code should be 400 (Reverted) and status should be 'reverted'
                expect(excessStatus.statusCode).toBe(400)
                expect(excessStatus.status).toBe('reverted')

                // The intent_error field should contain the ExceededSpendLimit selector
                expect(excessStatus.receipt?.intentError).toBeDefined()
                expect(decodeIntentError(excessStatus.receipt!.intentError!)).toBe(
                    'ExceededSpendLimit',
                )

                // Verify the transfer didn't happen by checking balances
                const balanceAfterExcess = await client.getBalance({
                    address: ownerAccount.address,
                })
                // Balance should be same as after first transfer (excess transfer was reverted)
                expect(balanceAfterExcess).toBe(balanceAfter)
            }
        },
    )
})
