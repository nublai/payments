/**
 * Stress Test 1: Parallel Execution
 *
 * Tests the signer pool system by executing multiple intents in parallel.
 * Tests concurrency, nonce management, and signer pool behavior.
 *
 * The test scales parallelism based on reported relayer capacity.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { createWalletClient, http, parseEther, type Hex, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { waitForBundle, type CapabilitiesResponse } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestClient } from '../helpers/client'

interface AccountSetup {
    privateKey: Hex
    account: ReturnType<typeof privateKeyToAccount>
    address: Address
    created: boolean
}

interface ExecutionResult {
    index: number
    success: boolean
    bundleId?: string
    error?: string
    durationMs: number
    nonce: string
}

describe('Parallel Execution Stress Test', () => {
    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    let caps: CapabilitiesResponse
    let availableCapacity: number
    const contracts = TEST_CONTRACTS

    beforeAll(async () => {
        caps = await client.getCapabilities()
        expect(caps.success).toBe(true)
        expect(caps.pool).toBeDefined()

        // Determine available capacity
        availableCapacity = caps.pool.availableCapacity
    })

    /**
     * Create a delegated account and return the setup info
     */
    async function createTestAccount(): Promise<AccountSetup> {
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)

        await setBalance(account.address, parseEther('10'))

        const result = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })

        if (!result.success) {
            throw new Error(`Failed to create account: ${result.error}`)
        }

        // Wait for transaction to be mined
        await new Promise((resolve) => setTimeout(resolve, 1000))

        return {
            privateKey,
            account,
            address: account.address,
            created: true,
        }
    }

    /**
     * Execute a single intent and measure timing
     */
    async function executeIntent(
        accountSetup: AccountSetup,
        index: number,
        seqKey: bigint = 0n,
    ): Promise<ExecutionResult> {
        const startTime = performance.now()

        try {
            const prepared = await client.prepareCalls({
                from: accountSetup.address,
                seqKey,
                calls: [
                    {
                        target: accountSetup.address, // Self-call
                        value: 0n,
                        data: '0x',
                    },
                ],
            })

            const walletClient = createWalletClient({
                account: accountSetup.account,
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
            const durationMs = performance.now() - startTime

            return {
                index,
                success: true,
                bundleId: result.id,
                durationMs,
                nonce: prepared.context.nonce,
            }
        } catch (error) {
            const durationMs = performance.now() - startTime
            return {
                index,
                success: false,
                error: error instanceof Error ? error.message : String(error),
                durationMs,
                nonce: '0',
            }
        }
    }

    it(
        'should execute multiple intents with separate accounts in parallel',
        { timeout: 120000 },
        async () => {
            // Scale test size based on capacity (use 80% of available capacity)
            const targetCount = Math.min(10, Math.max(3, Math.floor(availableCapacity * 0.8)))

            console.log(`\n  Capacity: ${availableCapacity}, creating ${targetCount} accounts`)

            // Create accounts in sequence (they share the relayer's nonce space for creation)
            const accounts: AccountSetup[] = []
            for (let i = 0; i < targetCount; i++) {
                const account = await createTestAccount()
                accounts.push(account)
                process.stdout.write(`\r  Created ${i + 1}/${targetCount} accounts`)
            }
            console.log()

            // Execute intents in parallel - each account has its own nonce space
            console.log(`  Executing ${targetCount} intents in parallel...`)
            const execStart = performance.now()

            const results = await Promise.all(
                accounts.map((account, i) => executeIntent(account, i)),
            )

            const execDuration = performance.now() - execStart

            // Analyze results
            const successful = results.filter((r) => r.success)
            const failed = results.filter((r) => !r.success)

            console.log(`  Completed in ${execDuration.toFixed(0)}ms`)
            console.log(`  Success: ${successful.length}/${results.length}`)

            if (failed.length > 0) {
                const errorSummary = new Map<string, number>()
                for (const r of failed) {
                    const error = r.error || 'Unknown'
                    errorSummary.set(error, (errorSummary.get(error) || 0) + 1)
                }
                console.log(`  Errors:`)
                for (const [error, count] of errorSummary) {
                    console.log(`    [${count}x] ${error.slice(0, 60)}`)
                }
            }

            // Calculate throughput
            const throughput = (results.length / (execDuration / 1000)).toFixed(2)
            console.log(`  Throughput: ${throughput} intents/second`)

            // Latency stats
            const durations = results.map((r) => r.durationMs).sort((a, b) => a - b)
            const p50 = durations[Math.floor(durations.length * 0.5)]
            const p95 = durations[Math.floor(durations.length * 0.95)]
            console.log(`  Latency P50: ${p50.toFixed(0)}ms, P95: ${p95.toFixed(0)}ms`)

            // Assertions
            expect(successful.length).toBeGreaterThanOrEqual(Math.floor(targetCount * 0.8))
        },
    )

    it(
        'should execute multiple intents from same account using 2D nonces',
        { timeout: 90000 },
        async () => {
            // Create single account
            const account = await createTestAccount()
            console.log(`\n  Created account: ${account.address.slice(0, 10)}...`)

            // Execute intents in parallel using different seqKeys (2D nonce)
            // This allows parallel execution from the same account
            const targetCount = Math.min(5, Math.max(2, Math.floor(availableCapacity * 0.5)))

            console.log(`  Executing ${targetCount} intents with different seqKeys...`)
            const execStart = performance.now()

            const results = await Promise.all(
                Array.from(
                    { length: targetCount },
                    (_, i) => executeIntent(account, i, BigInt(i)), // Each intent uses a different seqKey
                ),
            )

            const execDuration = performance.now() - execStart

            // Analyze results
            const successful = results.filter((r) => r.success)
            const failed = results.filter((r) => !r.success)

            console.log(`  Completed in ${execDuration.toFixed(0)}ms`)
            console.log(`  Success: ${successful.length}/${results.length}`)

            if (failed.length > 0) {
                console.log(`  Failed intents:`)
                for (const r of failed) {
                    console.log(`    [${r.index}] ${r.error}`)
                }
            }

            // Wait for all successful bundles to confirm
            if (successful.length > 0) {
                console.log(`  Waiting for ${successful.length} bundle confirmations...`)
                await Promise.all(
                    successful.map((r) =>
                        waitForBundle(client, {
                            id: r.bundleId!,
                            timeoutMs: 60000,
                            intervalMs: 1000,
                        }).catch(() => null),
                    ),
                )
            }

            // All intents should succeed when using different seqKeys
            expect(successful.length).toBe(targetCount)
        },
    )

    it('should handle capacity limits gracefully', { timeout: 120000 }, async () => {
        // Create a single account
        const account = await createTestAccount()
        console.log(`\n  Testing capacity limits...`)

        // Try to submit more intents than capacity allows
        const overCapacity = Math.floor(availableCapacity * 1.5) + 1
        const batchSize = Math.min(availableCapacity, 10)

        console.log(`  Submitting ${overCapacity} intents (capacity: ${availableCapacity})`)

        // Submit in batches, waiting for confirmations between batches
        const allResults: ExecutionResult[] = []
        let intentIndex = 0

        while (intentIndex < overCapacity) {
            const currentBatchSize = Math.min(batchSize, overCapacity - intentIndex)

            // Submit batch with different seqKeys
            const batchResults = await Promise.all(
                Array.from({ length: currentBatchSize }, (_, i) =>
                    executeIntent(account, intentIndex + i, BigInt(intentIndex + i)),
                ),
            )

            allResults.push(...batchResults)

            // Wait for bundle confirmations before next batch
            const successful = batchResults.filter((r) => r.success && r.bundleId)
            if (successful.length > 0) {
                await Promise.all(
                    successful.map((r) =>
                        waitForBundle(client, {
                            id: r.bundleId!,
                            timeoutMs: 60000,
                            intervalMs: 1000,
                        }).catch(() => null),
                    ),
                )
            }

            intentIndex += currentBatchSize
            process.stdout.write(`\r  Progress: ${intentIndex}/${overCapacity}`)
        }
        console.log()

        const successful = allResults.filter((r) => r.success)
        const failed = allResults.filter((r) => !r.success)

        console.log(
            `  Total: ${allResults.length}, Success: ${successful.length}, Failed: ${failed.length}`,
        )

        // With batching and waits, most should succeed
        expect(successful.length).toBeGreaterThanOrEqual(Math.floor(overCapacity * 0.7))
    })

    it('reports throughput metrics', async () => {
        // This test is primarily for reporting metrics
        const metrics = {
            signerCount: caps.pool.signerCount,
            totalCapacity: caps.pool.totalCapacity,
            availableCapacity: caps.pool.availableCapacity,
        }

        console.log('\n  Relayer Metrics:')
        console.log(`    Signers: ${metrics.signerCount}`)
        console.log(`    Total Capacity: ${metrics.totalCapacity}`)
        console.log(`    Available: ${metrics.availableCapacity}`)

        // Just verify we can get metrics
        expect(caps.success).toBe(true)
        expect(metrics.totalCapacity).toBeGreaterThan(0)
    })
})
