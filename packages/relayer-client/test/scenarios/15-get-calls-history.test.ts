/**
 * Test 15: wallet_getCallsHistory RPC Method
 *
 * Verifies that wallet_getCallsHistory returns the correct bundle history for an EOA:
 * 1. Returns empty results for an address with no bundles
 * 2. Returns bundle IDs after submitting calls
 * 3. Pagination (limit/offset) works correctly
 */

import { describe, it, expect } from 'vitest'
import { createWalletClient, http, parseEther, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { waitForBundle } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, testChain, TEST_CONTRACTS } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestClient } from '../helpers/client'

describe('wallet_getCallsHistory', () => {
    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    const contracts = TEST_CONTRACTS

    async function delegateAndFund(privateKey: `0x${string}`) {
        const account = privateKeyToAccount(privateKey)
        await setBalance(account.address, parseEther('2'))

        const result = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })

        if (!result.success) throw new Error(result.error ?? 'upgradeAccount failed')
        await new Promise((resolve) => setTimeout(resolve, 2000))

        return account
    }

    async function submitBundle(privateKey: `0x${string}`) {
        const account = privateKeyToAccount(privateKey)

        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [{ target: zeroAddress, value: 0n, data: '0x' }],
        })

        const signature = await walletClient.signTypedData({
            domain: prepared.typedData.domain,
            types: prepared.typedData.types,
            primaryType: prepared.typedData.primaryType,
            message: prepared.typedData.message,
        })

        const sent = await client.sendPreparedCalls({ context: prepared.context, signature })
        await waitForBundle(client, { id: sent.id, timeoutMs: 30000 })

        return sent.id
    }

    it('returns empty history for unknown address', async () => {
        const { address } = privateKeyToAccount(generatePrivateKey())

        const result = await client.getCallsHistory({ address })

        expect(result.success).toBe(true)

        if (!result.success) throw new Error(result.error)
        expect(result.items).toEqual([])
        expect(result.total).toBe(0)
    })

    it('returns bundle in history after submitting calls', { timeout: 60000 }, async () => {
        const privateKey = generatePrivateKey()
        await delegateAndFund(privateKey)
        const account = privateKeyToAccount(privateKey)

        const bundleId = await submitBundle(privateKey)

        const history = await client.getCallsHistory({ address: account.address })

        expect(history.success).toBe(true)

        if (!history.success) throw new Error(history.error)
        expect(history.total).toBeGreaterThanOrEqual(1)

        const found = history.items!.find((item) => item.id === bundleId)
        expect(found).toBeDefined()
        expect(found!.chainId).toBe(testChain.id)
        expect(found!.createdAt).toBeGreaterThan(0)
    })

    it('respects limit and offset', { timeout: 90000 }, async () => {
        const privateKey = generatePrivateKey()
        await delegateAndFund(privateKey)
        const account = privateKeyToAccount(privateKey)

        const id1 = await submitBundle(privateKey)
        const id2 = await submitBundle(privateKey)

        const page1 = await client.getCallsHistory({ address: account.address, limit: 1 })
        expect(page1.success).toBe(true)

        if (!page1.success) throw new Error(page1.error)
        expect(page1.items!.length).toBe(1)
        expect(page1.total).toBe(2)

        const page2 = await client.getCallsHistory({
            address: account.address,
            limit: 1,
            offset: 1,
        })

        expect(page2.success).toBe(true)

        if (!page2.success) throw new Error(page2.error)
        expect(page2.items!.length).toBe(1)
        expect(page2.total).toBe(2)

        const allIds = [...page1.items!.map((i) => i.id), ...page2.items!.map((i) => i.id)]
        expect(allIds).toContain(id1)
        expect(allIds).toContain(id2)
    })
})
