/**
 * Test 6: Escrow Buyer Flow
 *
 * Verifies the end-to-end escrow lifecycle using the escrow module:
 *
 * Happy path:
 *   1. Buyer creates a delegated Account
 *   2. Buyer funds with USDC
 *   3. Bot prepares escrow intent (approve + escrow), buyer signs, bot submits
 *   4. Oracle signs EIP-712 SettlementWrite
 *   5. Bot submits writeSettlementCalls — SimpleSettler.write + Escrow.settle in one intent
 *   6. Verify USDC moved to seller
 *
 * Refund path:
 *   1. Buyer creates escrow with a short deadline
 *   2. Fast-forward past the deadline
 *   3. Bot submits refundEscrowCalls
 *   4. Verify USDC returned to buyer
 */

import { describe, it, expect } from 'vitest'
import {
    createPublicClient,
    createWalletClient,
    createTestClient,
    http,
    parseUnits,
    parseEther,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import {
    waitForBundle,
    createEscrowCalls,
    computeEscrowId,
    getEscrowStatus,
    signSettlement,
    writeSettlementCalls,
    refundEscrowCalls,
} from '../../src'
import {
    ANVIL_RPC_URL,
    RELAYER_URL,
    TEST_CHAIN_ID,
    TEST_CONTRACTS,
    TEST_ACCOUNTS,
    testChain,
} from '../setup'
import { setBalance, deal, getERC20Balance } from '../helpers/anvil'
import { BASE_TOKENS } from '../helpers/tokens'
import { createRelayerTestClient } from '../helpers/client'

const USDC = BASE_TOKENS.USDC
const USDC_AMOUNT = parseUnits('100', 6) // 100 USDC
const ESCROW_AMOUNT = parseUnits('50', 6) // 50 USDC

describe('Escrow Buyer Flow', () => {
    const {
        escrow: escrowAddress,
        simpleSettler: simpleSettlerAddress,
        accountProxy,
    } = TEST_CONTRACTS

    if (!escrowAddress || !simpleSettlerAddress) {
        const missing = [
            escrowAddress ? '' : `ESCROW_${TEST_CHAIN_ID}`,
            simpleSettlerAddress ? '' : `SIMPLE_SETTLER_${TEST_CHAIN_ID}`,
        ].filter((name) => name !== '')

        throw new Error(
            `Escrow scenario is missing ${missing.join(' and ')}. ` +
                'Run make-config so contracts/deployments/envs/local/.env sets them.',
        )
    }

    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    const publicClient = createPublicClient({
        chain: testChain,
        transport: http(ANVIL_RPC_URL),
    })

    const signAndSubmit = async (
        account: ReturnType<typeof privateKeyToAccount>,
        prepared: Awaited<ReturnType<typeof client.prepareCalls>>,
    ) => {
        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })
        const signature = await walletClient.signTypedData(prepared.typedData)
        return client.sendPreparedCalls({ context: prepared.context, signature })
    }

    const createDelegatedAccount = async () => {
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('0.1'))
        const result = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: accountProxy,
        })
        expect(result.success).toBe(true)
        return { account, privateKey }
    }

    it(
        'happy path: buyer creates escrow, oracle settles, USDC released to seller',
        { timeout: 90_000 },
        async () => {
            // SimpleSettler.write() verifies signature against owner(), which is the deployer
            const oraclePrivateKey = TEST_ACCOUNTS.deployer.privateKey
            const oracleAccount = privateKeyToAccount(oraclePrivateKey)

            const { account: buyer, privateKey: buyerKey } = await createDelegatedAccount()
            const seller = privateKeyToAccount(generatePrivateKey())

            await deal(buyer.address, USDC, USDC_AMOUNT)

            const orderId = `0x${'ca'.repeat(32)}` as `0x${string}`
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600) // 1 hour from now
            const chainId = testChain.id

            const escrowParams = {
                buyer: buyer.address,
                seller: seller.address,
                usdcAmount: ESCROW_AMOUNT,
                deadline,
                orderId,
                oracleAddress: oracleAccount.address,
                usdcAddress: USDC,
                escrowAddress,
                simpleSettlerAddress,
                chainId,
            }

            // Step 1: Bot prepares escrow intent (approve + escrow), buyer signs, bot submits
            const buyerUsdcBefore = await getERC20Balance(USDC, buyer.address)
            const escrowUsdcBefore = await getERC20Balance(USDC, escrowAddress)

            const createPrepared = await client.prepareCalls({
                from: buyer.address,
                calls: createEscrowCalls(escrowParams),
            })
            const createResult = await signAndSubmit(privateKeyToAccount(buyerKey), createPrepared)
            const createStatus = await waitForBundle(client, { id: createResult.id })
            expect(createStatus.statusCode).toBe(200)

            // Verify USDC locked in escrow
            const buyerUsdcAfterCreate = await getERC20Balance(USDC, buyer.address)
            const escrowUsdcAfterCreate = await getERC20Balance(USDC, escrowAddress)
            expect(buyerUsdcAfterCreate).toBe(buyerUsdcBefore - ESCROW_AMOUNT)
            expect(escrowUsdcAfterCreate).toBe(escrowUsdcBefore + ESCROW_AMOUNT)

            const escrowId = computeEscrowId(escrowParams)
            const statusAfterCreate = await getEscrowStatus({
                escrowId,
                escrowAddress,
                publicClient,
            })
            expect(statusAfterCreate.status).toBe('created')

            // Step 2: Oracle signs settlement
            const signature = await signSettlement({
                settlementId: orderId,
                oracleAddress: oracleAccount.address,
                chainId,
                simpleSettlerAddress,
                oraclePrivateKey,
            })

            // Step 3: Bot submits settlement (SimpleSettler.write + Escrow.settle in one intent)
            const { account: botAccount, privateKey: botKey } = await createDelegatedAccount()
            const sellerUsdcBefore = await getERC20Balance(USDC, seller.address)

            const settlePrepared = await client.prepareCalls({
                from: botAccount.address,
                calls: writeSettlementCalls({
                    escrowId,
                    settlementId: orderId,
                    oracleAddress: oracleAccount.address,
                    chainId,
                    signature,
                    simpleSettlerAddress,
                    escrowAddress,
                }),
            })
            const settleResult = await signAndSubmit(privateKeyToAccount(botKey), settlePrepared)
            const settleStatus = await waitForBundle(client, { id: settleResult.id })
            expect(settleStatus.statusCode).toBe(200)

            const sellerUsdcAfter = await getERC20Balance(USDC, seller.address)
            expect(sellerUsdcAfter).toBe(sellerUsdcBefore + ESCROW_AMOUNT)

            const statusAfterSettle = await getEscrowStatus({
                escrowId,
                escrowAddress,
                publicClient,
            })
            expect(statusAfterSettle.status).toBe('finalized')
        },
    )

    it(
        'refund path: buyer creates escrow, deadline passes, USDC returned to buyer',
        { timeout: 90_000 },
        async () => {
            // SimpleSettler.write() verifies signature against owner(), which is the deployer
            const oraclePrivateKey = TEST_ACCOUNTS.deployer.privateKey
            const oracleAccount = privateKeyToAccount(oraclePrivateKey)

            const { account: buyer, privateKey: buyerKey } = await createDelegatedAccount()
            await deal(buyer.address, USDC, USDC_AMOUNT)

            const orderId = `0x${'ef'.repeat(32)}` as `0x${string}`
            // Deadline 10 seconds from now — we'll fast-forward past it
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 10)
            const chainId = testChain.id

            const escrowParams = {
                buyer: buyer.address,
                seller: privateKeyToAccount(generatePrivateKey()).address,
                usdcAmount: ESCROW_AMOUNT,
                deadline,
                orderId,
                oracleAddress: oracleAccount.address,
                usdcAddress: USDC,
                escrowAddress,
                simpleSettlerAddress,
                chainId,
            }

            const createPrepared = await client.prepareCalls({
                from: buyer.address,
                calls: createEscrowCalls(escrowParams),
            })
            const createResult = await signAndSubmit(privateKeyToAccount(buyerKey), createPrepared)
            const createStatus = await waitForBundle(client, { id: createResult.id })
            expect(createStatus.statusCode).toBe(200)

            const escrowId = computeEscrowId(escrowParams)
            const statusAfterCreate = await getEscrowStatus({
                escrowId,
                escrowAddress,
                publicClient,
            })
            expect(statusAfterCreate.status).toBe('created')

            // Fast-forward past the deadline
            const testClient = createTestClient({
                chain: testChain,
                mode: 'anvil',
                transport: http(ANVIL_RPC_URL),
            })
            await testClient.increaseTime({ seconds: 60 })
            await testClient.mine({ blocks: 1 })

            const buyerUsdcBeforeRefund = await getERC20Balance(USDC, buyer.address)

            const { account: botAccount, privateKey: botKey } = await createDelegatedAccount()
            const refundPrepared = await client.prepareCalls({
                from: botAccount.address,
                calls: refundEscrowCalls({ escrowId, escrowAddress }),
            })
            const refundResult = await signAndSubmit(privateKeyToAccount(botKey), refundPrepared)
            const refundStatus = await waitForBundle(client, { id: refundResult.id })
            expect(refundStatus.statusCode).toBe(200)

            const buyerUsdcAfterRefund = await getERC20Balance(USDC, buyer.address)
            expect(buyerUsdcAfterRefund).toBe(buyerUsdcBeforeRefund + ESCROW_AMOUNT)

            // Escrow.refund() atomically calls _refundDepositor then _refundRecipient,
            // so status goes CREATED → REFUND_DEPOSIT → FINALIZED in one tx
            const statusAfterRefund = await getEscrowStatus({
                escrowId,
                escrowAddress,
                publicClient,
            })
            expect(statusAfterRefund.status).toBe('finalized')
        },
    )
})
