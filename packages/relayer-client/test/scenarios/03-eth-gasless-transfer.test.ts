/**
 * Test 3: ETH Gasless Transfer
 *
 * Verifies gasless ETH transfers:
 * 1. Create delegated account
 * 2. Fund account with ETH
 * 3. Record ETH balance before
 * 4. Send ETH via intent (value transfer)
 * 5. Assert: Only value amount deducted, no gas paid by user
 */

import { describe, it, expect } from 'vitest'
import { createWalletClient, http, parseEther, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { waitForBundle } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestClient } from '../helpers/client'

describe('ETH Gasless Transfer', () => {
    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    const contracts = TEST_CONTRACTS
    const recipient = '0x000000000000000000000000000000000000dEaD'

    it('should transfer ETH without paying gas', { timeout: 30000 }, async () => {
        // 1. Create delegated account
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)

        const initialBalance = parseEther('10') // 10 ETH
        await setBalance(account.address, initialBalance)

        const createResult = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })
        expect(createResult.success).toBe(true)

        // 2. Verify account creation was gasless - balance should be unchanged
        const senderBefore = await client.getBalance({
            address: account.address,
        })
        expect(senderBefore).toBe(initialBalance) // Account creation must be gasless

        const recipientBefore = await client.getBalance({
            address: recipient,
        })

        // 3. Transfer ETH via intent
        const transferAmount = parseEther('1') // 1 ETH

        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [
                {
                    target: recipient,
                    value: transferAmount,
                    data: '0x',
                },
            ],
        })

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

        // 4. Verify transfer
        const senderAfter = await client.getBalance({
            address: account.address,
        })
        const recipientAfter = await client.getBalance({
            address: recipient,
        })

        // GASLESS VERIFICATION:
        // Sender should have EXACTLY (initialBalance - transferAmount)
        // If the user paid ANY gas, this would be less
        expect(senderAfter).toBe(initialBalance - transferAmount)
        expect(senderAfter).toBe(senderBefore - transferAmount)

        // Recipient should have exactly transferAmount more
        expect(recipientAfter).toBe(recipientBefore + transferAmount)
    })

    it('should handle multiple ETH transfers in single intent', { timeout: 30000 }, async () => {
        // Setup
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('10'))

        const createResult = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })
        expect(createResult.success).toBe(true)

        // Multiple recipients - use addresses outside precompile range (0x01-0x14 are precompiles in Prague)
        const recipient1 = '0x0000000000000000000000000000000000001001'
        const recipient2 = '0x0000000000000000000000000000000000001002'
        const amount1 = parseEther('0.5')
        const amount2 = parseEther('0.3')

        // Record balances BEFORE
        const senderBefore = await client.getBalance({
            address: account.address,
        })
        const recipient1Before = await client.getBalance({ address: recipient1 })
        const recipient2Before = await client.getBalance({ address: recipient2 })

        // Multi-call intent
        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [
                { target: recipient1, value: amount1, data: '0x' },
                { target: recipient2, value: amount2, data: '0x' },
            ],
        })

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

        // Verify - check DIFFERENCES not absolute values
        const senderAfter = await client.getBalance({
            address: account.address,
        })
        const recipient1After = await client.getBalance({ address: recipient1 })
        const recipient2After = await client.getBalance({ address: recipient2 })

        // Exact deduction (no gas) - sender loses exactly amount1 + amount2
        expect(senderAfter).toBe(senderBefore - amount1 - amount2)
        // Recipients gain exactly the amounts sent
        expect(recipient1After - recipient1Before).toBe(amount1)
        expect(recipient2After - recipient2Before).toBe(amount2)
    })

    it('should fail simulation when transfer amount exceeds balance', async () => {
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('1')) // Only 1 ETH

        const createResult = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })
        expect(createResult.success).toBe(true)

        // Try to transfer more than balance - simulation should catch this
        await expect(
            client.prepareCalls({
                from: account.address,
                calls: [
                    {
                        target: recipient,
                        value: parseEther('10'), // More than balance
                        data: '0x',
                    },
                ],
            }),
        ).rejects.toThrow(/Simulation failed/)

        // Verify: balance unchanged
        const balanceAfter = await client.getBalance({ address: account.address })
        expect(balanceAfter).toBe(parseEther('1'))
    })

    it('should track bundle status after submission', { timeout: 15000 }, async () => {
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('5'))

        const createResult = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })
        expect(createResult.success).toBe(true)

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

        // Verify the transfer happened
        const recipientBalance = await client.getBalance({ address: recipient })
        expect(recipientBalance).toBeGreaterThan(0n)
    })

    it('should transfer ETH using WalletClient signing', { timeout: 30000 }, async () => {
        // 1. Create delegated account
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)

        const initialBalance = parseEther('10') // 10 ETH
        await setBalance(account.address, initialBalance)

        const createResult = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })
        expect(createResult.success).toBe(true)

        // 2. Create wallet client for signing (simulates browser wallet)
        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        // 3. Record balances before
        const senderBefore = await client.getBalance({
            address: account.address,
        })
        expect(senderBefore).toBe(initialBalance) // Account creation must be gasless

        const recipientBefore = await client.getBalance({
            address: recipient,
        })

        // 4. Transfer ETH via intent using wallet client
        const transferAmount = parseEther('1') // 1 ETH

        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [
                {
                    target: recipient,
                    value: transferAmount,
                    data: '0x',
                },
            ],
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

        // 5. Verify transfer - GASLESS: sender loses exactly transferAmount, no gas
        const senderAfter = await client.getBalance({
            address: account.address,
        })
        const recipientAfter = await client.getBalance({
            address: recipient,
        })

        expect(senderAfter).toBe(initialBalance - transferAmount)
        expect(recipientAfter).toBe(recipientBefore + transferAmount)
    })

    it(
        'should transfer ETH with payment fields (non-sponsored flow)',
        { timeout: 30000 },
        async () => {
            // #given - a delegated account with ETH
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)

            const initialBalance = parseEther('10')
            await setBalance(account.address, initialBalance)

            const createResult = await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })
            expect(createResult.success).toBe(true)

            const senderBefore = await client.getBalance({ address: account.address })
            expect(senderBefore).toBe(initialBalance)

            const recipientBefore = await client.getBalance({ address: recipient })

            // #when - transfer ETH with payment fields (user pays gas in ETH)
            const transferAmount = parseEther('1')
            const maxPayment = parseEther('0.01') // Max 0.01 ETH for gas reimbursement

            const prepared = await client.prepareCalls({
                from: account.address,
                calls: [
                    {
                        target: recipient,
                        value: transferAmount,
                        data: '0x',
                    },
                ],
                payer: account.address,
                paymentToken: zeroAddress, // Native ETH
                paymentMaxAmount: maxPayment,
            })

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

            const status = await waitForBundle(client, { id: result.id })
            expect(status.statusCode).toBe(200)
            expect(status.receipt?.transactionHash).toBeDefined()

            // #then - verify transfer succeeded and payment flow was valid
            const senderAfter = await client.getBalance({ address: account.address })
            const recipientAfter = await client.getBalance({ address: recipient })

            // Recipient receives exactly the transfer amount
            expect(recipientAfter).toBe(recipientBefore + transferAmount)

            // Sender loses at least the transfer amount
            const totalSpent = senderBefore - senderAfter
            expect(totalSpent).toBeGreaterThanOrEqual(transferAmount)
            expect(totalSpent).toBeLessThanOrEqual(transferAmount + maxPayment)
        },
    )

    it('should transfer ETH with third-party sponsor paying gas', { timeout: 30000 }, async () => {
        // #given - a user account and a separate sponsor account
        const userPrivateKey = generatePrivateKey()
        const userAccount = privateKeyToAccount(userPrivateKey)

        const sponsorPrivateKey = generatePrivateKey()
        const sponsorAccount = privateKeyToAccount(sponsorPrivateKey)

        const userInitialBalance = parseEther('1') // User only has ETH for the transfer
        const sponsorInitialBalance = parseEther('10') // Sponsor has ETH for gas

        await setBalance(userAccount.address, userInitialBalance)
        await setBalance(sponsorAccount.address, sponsorInitialBalance)

        // Create delegated accounts for both user and sponsor
        const userCreateResult = await client.upgradeAccount({
            accountAddress: userAccount.address,
            signerKey: userPrivateKey,
            delegation: contracts.accountProxy,
        })
        expect(userCreateResult.success).toBe(true)

        const sponsorCreateResult = await client.upgradeAccount({
            accountAddress: sponsorAccount.address,
            signerKey: sponsorPrivateKey,
            delegation: contracts.accountProxy,
        })
        expect(sponsorCreateResult.success).toBe(true)

        const userBefore = await client.getBalance({ address: userAccount.address })
        const sponsorBefore = await client.getBalance({ address: sponsorAccount.address })
        const recipientBefore = await client.getBalance({ address: recipient })

        // #when - user signs intent with sponsor as payer
        const transferAmount = parseEther('0.5')
        const maxPayment = parseEther('0.01')

        // User prepares and signs the intent specifying sponsor as the payer
        const prepared = await client.prepareCalls({
            from: userAccount.address,
            calls: [
                {
                    target: recipient,
                    value: transferAmount,
                    data: '0x',
                },
            ],
            payer: sponsorAccount.address, // Sponsor pays
            paymentToken: zeroAddress, // Native ETH
            paymentMaxAmount: maxPayment,
        })

        const userWallet = createWalletClient({
            account: userAccount,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        const userSignature = await userWallet.signTypedData({
            domain: prepared.typedData.domain,
            types: prepared.typedData.types,
            primaryType: prepared.typedData.primaryType,
            message: prepared.typedData.message,
        })

        // Sponsor signs payment authorization using the same typed data
        const sponsorWallet = createWalletClient({
            account: sponsorAccount,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        const paymentSignature = await sponsorWallet.signTypedData({
            domain: prepared.typedData.domain,
            types: prepared.typedData.types,
            primaryType: prepared.typedData.primaryType,
            message: prepared.typedData.message,
        })

        // Submit with both signatures
        const result = await client.sendPreparedCalls({
            context: prepared.context,
            signature: userSignature,
            paymentSignature,
        })
        expect(result.id).toBeDefined()

        const status = await waitForBundle(client, { id: result.id })
        expect(status.statusCode).toBe(200)
        expect(status.receipt?.transactionHash).toBeDefined()

        // #then - verify transfer succeeded and sponsor paid for gas
        const userAfter = await client.getBalance({ address: userAccount.address })
        const sponsorAfter = await client.getBalance({ address: sponsorAccount.address })
        const recipientAfter = await client.getBalance({ address: recipient })

        // Recipient receives exactly the transfer amount
        expect(recipientAfter).toBe(recipientBefore + transferAmount)

        // User loses ONLY the transfer amount (no gas)
        expect(userAfter).toBe(userBefore - transferAmount)

        // Sponsor pays the gas (loses some ETH up to maxPayment)
        const sponsorSpent = sponsorBefore - sponsorAfter
        expect(sponsorSpent).toBeGreaterThan(0n)
        expect(sponsorSpent).toBeLessThanOrEqual(maxPayment)
    })
})
