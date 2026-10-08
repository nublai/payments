/**
 * Test 2: ERC20 Gasless Transfer
 *
 * Verifies gasless ERC20 transfers:
 * 1. Create delegated account
 * 2. Fund account with USDC (not ETH for gas)
 * 3. Record ETH balance before
 * 4. Transfer USDC via intent
 * 5. Assert: ETH balance unchanged, USDC transferred
 */

import { describe, it, expect } from 'vitest'
import {
    createWalletClient,
    http,
    encodeFunctionData,
    erc20Abi,
    parseEther,
    parseUnits,
    type Address,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { waitForBundle, type PrepareCallsContext } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain, MOCK_RECIPIENT } from '../setup'
import { setBalance, deal, getERC20Balance } from '../helpers/anvil'
import { BASE_TOKENS } from '../helpers/tokens'
import { createRelayerTestClient } from '../helpers/client'

// These tests work in both local mode (MockUSDC) and fork mode (real USDC)
// Local mode: MockUSDC is deployed at Base mainnet USDC address via anvil_setCode
// Fork mode: Real USDC from forked Base mainnet
describe('ERC20 Gasless Transfer', () => {
    const { accountProxy } = TEST_CONTRACTS

    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    // USDC address (Base mainnet, used in forked tests)
    const USDC = BASE_TOKENS.USDC
    const USDC_UNITS = 6
    const USDC_AMOUNT = parseUnits('100', USDC_UNITS) // 100 USDC (6 decimals)
    const ACCOUNT_CREATION_ETH = parseEther('0.1')

    const buildUsdcTransferCall = (to: Address, amount: bigint) => ({
        target: USDC,
        value: 0n,
        data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [to, amount],
        }),
    })

    const getQuotedPaymentAmount = (context: PrepareCallsContext) => {
        const paymentAmount = context.quote.quotes[0]?.paymentAmount

        return BigInt(paymentAmount ?? '0')
    }

    const signPreparedCalls = async (
        account: ReturnType<typeof privateKeyToAccount>,
        prepared: Awaited<ReturnType<typeof client.prepareCalls>>,
    ) => {
        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        const { domain, types, primaryType, message } = prepared.typedData

        return walletClient.signTypedData({
            domain,
            types,
            primaryType,
            message,
        })
    }

    const createDelegatedAccount = async () => {
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, ACCOUNT_CREATION_ETH)

        const result = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: accountProxy,
        })

        return { account, privateKey, result }
    }

    it('should transfer USDC without using ETH for gas', { timeout: 45000 }, async () => {
        // 1. Generate and create delegated account
        const { account, result: upgradeResult } = await createDelegatedAccount()
        expect(upgradeResult.success).toBe(true)

        // 2. Fund account with USDC
        await deal(account.address, USDC, USDC_AMOUNT)

        // 3. Record balances before
        const ethBefore = await client.getBalance({
            address: account.address,
        })

        const usdcBefore = await getERC20Balance(USDC, account.address)
        const recipientUsdcBefore = await getERC20Balance(USDC, MOCK_RECIPIENT)

        expect(usdcBefore).toBeGreaterThanOrEqual(USDC_AMOUNT)

        const transferAmount = parseUnits('10', USDC_UNITS) // 10 USDC
        const transferCall = buildUsdcTransferCall(MOCK_RECIPIENT, transferAmount)

        // 4. Prepare, sign, and send
        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [transferCall],
        })

        const signature = await signPreparedCalls(account, prepared)

        const sendResult = await client.sendPreparedCalls({
            context: prepared.context,
            signature,
        })

        expect(sendResult.id).toBeDefined()

        // Wait for bundle to reach final status
        const status = await waitForBundle(client, { id: sendResult.id })
        expect(status.statusCode).toBe(200)
        expect(status.receipt?.transactionHash).toBeDefined()

        // 6. Verify transfer
        const ethAfter = await client.getBalance({ address: account.address })
        const usdcAfter = await getERC20Balance(USDC, account.address)
        const recipientUsdcAfter = await getERC20Balance(USDC, MOCK_RECIPIENT)

        // ETH balance should be unchanged (gasless!)
        expect(ethAfter).toBe(ethBefore)

        // USDC should be transferred
        expect(usdcAfter).toBe(usdcBefore - transferAmount)
        expect(recipientUsdcAfter).toBe(recipientUsdcBefore + transferAmount)
    })

    // Payment reimbursement: user pays gas fees in USDC instead of ETH
    // Uses prepareCalls to get a quote, then verifies the quoted payment before signing
    it(
        'should transfer USDC with payment reimbursement to relayer',
        { timeout: 45000 },
        async () => {
            const { account } = await createDelegatedAccount()

            const fundingAmount = parseUnits('200', USDC_UNITS)
            await deal(account.address, USDC, fundingAmount)

            const ethBefore = await client.getBalance({ address: account.address })

            const transferAmount = parseUnits('50', USDC_UNITS)
            const transferCall = buildUsdcTransferCall(MOCK_RECIPIENT, transferAmount)

            // Get quote from relayer using prepareCalls. Set a high ceiling to get the quote, then verify it's acceptable.
            const maxPaymentCeiling = parseUnits('100', USDC_UNITS)

            const prepared = await client.prepareCalls({
                from: account.address,
                calls: [transferCall],
                payer: account.address,
                paymentToken: USDC,
                paymentMaxAmount: maxPaymentCeiling,
            })

            const quotedPayment = getQuotedPaymentAmount(prepared.context)
            expect(quotedPayment).toBeLessThan(parseUnits('50', USDC_UNITS))
            const signature = await signPreparedCalls(account, prepared)

            const result = await client.sendPreparedCalls({
                context: prepared.context,
                signature,
            })

            expect(result.id).toBeDefined()

            const status = await waitForBundle(client, { id: result.id })

            if (status.status !== 'confirmed') {
                const quote = prepared.context.quote.quotes[0]

                throw new Error(
                    `Reimbursement bundle not confirmed: ${JSON.stringify(
                        {
                            bundleId: result.id,
                            status: status.status,
                            statusCode: status.statusCode,
                            error: status.error,
                            quote: quote
                                ? {
                                      txGas: quote.txGas,
                                      paymentAmount: quote.paymentAmount,
                                      combinedGas: quote.intent?.combinedGas,
                                      encodedFundTransfers:
                                          quote.intent?.encodedFundTransfers?.length ?? 0,
                                      maxFeePerGas: quote.nativeFeeEstimate?.maxFeePerGas,
                                      maxPriorityFeePerGas:
                                          quote.nativeFeeEstimate?.maxPriorityFeePerGas,
                                  }
                                : undefined,
                            receipt: status.receipt
                                ? {
                                      transactionHash: status.receipt.transactionHash,
                                      blockNumber: status.receipt.blockNumber,
                                      gasUsed: status.receipt.gasUsed,
                                      intentError: status.receipt.intentError,
                                  }
                                : undefined,
                        },
                        null,
                        2,
                    )}`,
                )
            }

            expect(status.status).toBe('confirmed')

            const ethAfter = await client.getBalance({ address: account.address })
            const usdcAfter = await getERC20Balance(USDC, account.address)

            expect(ethAfter).toBe(ethBefore)

            const usdcSpent = fundingAmount - usdcAfter
            expect(usdcSpent).toBeGreaterThanOrEqual(transferAmount)
            expect(usdcSpent).toBeLessThanOrEqual(transferAmount + quotedPayment)
        },
    )

    it('should handle multiple calls in a single intent', { timeout: 45000 }, async () => {
        // 1. Setup account
        const { account, result: upgradeResult } = await createDelegatedAccount()
        expect(upgradeResult.success).toBe(true)

        // 2. Fund with USDC
        await deal(account.address, USDC, parseUnits('100', USDC_UNITS))

        // 3. Multiple recipients
        const recipient1 = '0x0000000000000000000000000000000000000001'
        const recipient2 = '0x0000000000000000000000000000000000000002'
        const amount1 = parseUnits('10', USDC_UNITS)
        const amount2 = parseUnits('20', USDC_UNITS)

        // Record balances before (these addresses may already have USDC on mainnet fork)
        const balance1Before = await getERC20Balance(USDC, recipient1)
        const balance2Before = await getERC20Balance(USDC, recipient2)

        // 4. Prepare, sign, and send multi-call intent
        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [
                buildUsdcTransferCall(recipient1, amount1),
                buildUsdcTransferCall(recipient2, amount2),
            ],
        })

        const signature = await signPreparedCalls(account, prepared)

        const sendResult = await client.sendPreparedCalls({
            context: prepared.context,
            signature,
        })

        expect(sendResult.id).toBeDefined()

        // Wait for bundle to reach final status
        const status = await waitForBundle(client, { id: sendResult.id })
        expect(status.statusCode).toBe(200)

        // 5. Verify both transfers - check the delta, not absolute value
        const balance1After = await getERC20Balance(USDC, recipient1)
        const balance2After = await getERC20Balance(USDC, recipient2)

        expect(balance1After - balance1Before).toBe(amount1)
        expect(balance2After - balance2Before).toBe(amount2)
    })
})
