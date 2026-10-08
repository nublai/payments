/**
 * Test 8: WalletClient Integration (Privy-style)
 *
 * Verifies the relayer-client works correctly with WalletClient-based signing,
 * which is how external wallet providers like Privy work.
 *
 * This tests the flow using WalletClient for signing:
 * - upgradeAccount
 * - prepareCalls + walletClient.signTypedData + sendPreparedCalls
 */

import { describe, it, expect } from 'vitest'
import {
    createWalletClient,
    http,
    parseEther,
    zeroAddress,
    encodeFunctionData,
    erc20Abi,
    type Address,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { waitForBundle } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance, deal, getERC20Balance } from '../helpers/anvil'
import { BASE_TOKENS } from '../helpers/tokens'
import { createRelayerTestClient } from '../helpers/client'

describe('WalletClient Integration (Privy-style)', () => {
    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    const contracts = TEST_CONTRACTS
    const recipient = '0x000000000000000000000000000000000000dEaD'
    const USDC = BASE_TOKENS.USDC

    /** Helper to create a wallet client from a private key */
    function createTestWalletClient(privateKey: `0x${string}`) {
        const account = privateKeyToAccount(privateKey)

        return createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })
    }

    /** Wait for EIP-7702 delegation code to appear on an account */
    async function waitForDelegation(address: Address, timeoutMs = 10000) {
        const start = Date.now()

        while (Date.now() - start < timeoutMs) {
            const code = await client.getCode({ address })

            if (code && code !== '0x' && code.startsWith('0xef0100')) {
                return // Delegation code is present
            }

            await new Promise((r) => setTimeout(r, 100))
        }

        throw new Error(`Timeout waiting for delegation code on ${address}`)
    }

    describe('Account creation with WalletClient', () => {
        it('should create delegated account using upgradeAccount', { timeout: 30000 }, async () => {
            // #given - a wallet client
            const privateKey = generatePrivateKey()
            const walletClient = createTestWalletClient(privateKey)
            const account = walletClient.account!

            const initialBalance = parseEther('10')
            await setBalance(account.address, initialBalance)

            // #when - creating account using WalletClient
            const createResult = await client.upgradeAccount({
                accountAddress: account.address,
                walletClient,
                delegation: contracts.accountProxy,
            })

            // #then - account creation succeeds
            expect(createResult.success).toBe(true)

            // Wait for EIP-7702 delegation to be mined
            await waitForDelegation(account.address)

            // Verify account creation was gasless
            const balanceAfter = await client.getBalance({ address: account.address })
            expect(balanceAfter).toBe(initialBalance)
        })
    })

    describe('ETH transfer with WalletClient', () => {
        it('should transfer ETH using WalletClient signing', { timeout: 30000 }, async () => {
            // #given - a delegated account with WalletClient
            const privateKey = generatePrivateKey()
            const walletClient = createTestWalletClient(privateKey)
            const account = walletClient.account!

            const initialBalance = parseEther('10')
            await setBalance(account.address, initialBalance)

            // Create account first
            const createResult = await client.upgradeAccount({
                accountAddress: account.address,
                walletClient,
                delegation: contracts.accountProxy,
            })

            expect(createResult.success).toBe(true)
            await waitForDelegation(account.address)

            const senderBefore = await client.getBalance({ address: account.address })
            const recipientBefore = await client.getBalance({ address: recipient })

            // #when - prepare, sign with WalletClient, and submit intent
            const transferAmount = parseEther('1')

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

            const status = await waitForBundle(client, { id: result.id })
            expect(status.statusCode).toBe(200)
            expect(status.receipt?.transactionHash).toBeDefined()

            // #then - verify gasless transfer succeeded
            const senderAfter = await client.getBalance({ address: account.address })
            const recipientAfter = await client.getBalance({ address: recipient })

            // Sender loses ONLY the transfer amount (gasless)
            expect(senderAfter).toBe(senderBefore - transferAmount)
            expect(recipientAfter).toBe(recipientBefore + transferAmount)
        })
    })

    describe('ERC20 transfer with WalletClient', () => {
        it('should transfer USDC using WalletClient signing', { timeout: 45000 }, async () => {
            // #given - a delegated account with USDC
            const privateKey = generatePrivateKey()
            const walletClient = createTestWalletClient(privateKey)
            const account = walletClient.account!

            await setBalance(account.address, parseEther('0.1'))
            await deal(account.address, USDC, 100_000000n) // 100 USDC

            const createResult = await client.upgradeAccount({
                accountAddress: account.address,
                walletClient,
                delegation: contracts.accountProxy,
            })

            expect(createResult.success).toBe(true)
            await waitForDelegation(account.address)

            const ethBefore = await client.getBalance({ address: account.address })
            const usdcBefore = await getERC20Balance(USDC, account.address)
            const recipientUsdcBefore = await getERC20Balance(USDC, recipient)

            // #when - transfer USDC via intent
            const transferAmount = 10_000000n // 10 USDC

            const transferData = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [recipient, transferAmount],
            })

            const prepared = await client.prepareCalls({
                from: account.address,
                calls: [
                    {
                        target: USDC,
                        value: 0n,
                        data: transferData,
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

            const status = await waitForBundle(client, { id: result.id })
            expect(status.statusCode).toBe(200)

            // #then - verify gasless USDC transfer
            const ethAfter = await client.getBalance({ address: account.address })
            const usdcAfter = await getERC20Balance(USDC, account.address)
            const recipientUsdcAfter = await getERC20Balance(USDC, recipient)

            // ETH unchanged (gasless)
            expect(ethAfter).toBe(ethBefore)

            // USDC transferred correctly
            expect(usdcAfter).toBe(usdcBefore - transferAmount)
            expect(recipientUsdcAfter).toBe(recipientUsdcBefore + transferAmount)
        })
    })

    describe('Third-party sponsor with WalletClient', () => {
        it(
            'should transfer ETH with sponsor using WalletClient signing',
            { timeout: 30000 },
            async () => {
                // #given - user and sponsor wallet clients
                const userPrivateKey = generatePrivateKey()
                const userWallet = createTestWalletClient(userPrivateKey)
                const userAccount = userWallet.account!

                const sponsorPrivateKey = generatePrivateKey()
                const sponsorWallet = createTestWalletClient(sponsorPrivateKey)
                const sponsorAccount = sponsorWallet.account!

                const userInitialBalance = parseEther('1')
                const sponsorInitialBalance = parseEther('10')

                await setBalance(userAccount.address, userInitialBalance)
                await setBalance(sponsorAccount.address, sponsorInitialBalance)

                // Create delegated accounts for both
                const userCreateResult = await client.upgradeAccount({
                    accountAddress: userAccount.address,
                    walletClient: userWallet,
                    delegation: contracts.accountProxy,
                })

                expect(userCreateResult.success).toBe(true)

                const sponsorCreateResult = await client.upgradeAccount({
                    accountAddress: sponsorAccount.address,
                    walletClient: sponsorWallet,
                    delegation: contracts.accountProxy,
                })

                expect(sponsorCreateResult.success).toBe(true)

                // Wait for both delegations to be mined
                await Promise.all([
                    waitForDelegation(userAccount.address),
                    waitForDelegation(sponsorAccount.address),
                ])

                const userBefore = await client.getBalance({ address: userAccount.address })
                const sponsorBefore = await client.getBalance({ address: sponsorAccount.address })
                const recipientBefore = await client.getBalance({ address: recipient })

                // #when - user signs intent with sponsor as payer
                const transferAmount = parseEther('0.5')
                const maxPayment = parseEther('0.01')

                // Prepare the calls with sponsor as payer
                const prepared = await client.prepareCalls({
                    from: userAccount.address,
                    calls: [
                        {
                            target: recipient,
                            value: transferAmount,
                            data: '0x',
                        },
                    ],
                    payer: sponsorAccount.address,
                    paymentToken: zeroAddress,
                    paymentMaxAmount: maxPayment,
                })

                // User signs the intent
                const userSignature = await userWallet.signTypedData({
                    domain: prepared.typedData.domain,
                    types: prepared.typedData.types,
                    primaryType: prepared.typedData.primaryType,
                    message: prepared.typedData.message,
                })

                // Sponsor signs payment authorization using the same typed data
                // (they're authorizing payment for this specific intent)
                const sponsorSignature = await sponsorWallet.signTypedData({
                    domain: prepared.typedData.domain,
                    types: prepared.typedData.types,
                    primaryType: prepared.typedData.primaryType,
                    message: prepared.typedData.message,
                })

                // Submit with both signatures
                const result = await client.sendPreparedCalls({
                    context: prepared.context,
                    signature: userSignature,
                    paymentSignature: sponsorSignature,
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

                // Sponsor pays the gas
                const sponsorSpent = sponsorBefore - sponsorAfter
                expect(sponsorSpent).toBeGreaterThan(0n)
                expect(sponsorSpent).toBeLessThanOrEqual(maxPayment)
            },
        )
    })
})
