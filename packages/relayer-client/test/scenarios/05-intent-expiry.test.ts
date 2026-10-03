/**
 * Test 5: Intent Expiry Validation
 *
 * Verifies that the relayer rejects expired intents:
 * 1. Create delegated account
 * 2. Sign an intent with an already-expired timestamp
 * 3. Submit the expired intent
 * 4. Assert: Relayer returns INTENT_EXPIRED error (-32008)
 */

import { describe, it, expect } from 'vitest'
import { createWalletClient, http, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { createJsonRpcTransport, waitForBundle } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestAuthSigner, createRelayerTestClient } from '../helpers/client'

describe('Intent Expiry Validation', () => {
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

    const contracts = TEST_CONTRACTS
    const recipient = '0x000000000000000000000000000000000000dEaD'

    it(
        'should preserve prepareCalls expiry override through prepare -> sign -> send',
        { timeout: 60_000 },
        async () => {
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)

            await setBalance(account.address, parseEther('10'))

            const createResult = await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })
            expect(createResult.success).toBe(true)

            const walletClient = createWalletClient({
                account,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            // Use a valid far-future expiry so prepareCalls passes the buffer check.
            // The relayer enforces the buffer at prepare time too, so any expiry
            // within the buffer window causes simulation to fail.
            const customExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600)
            const prepared = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
                expiry: customExpiry,
            })

            // Verify the expiry override is preserved in both the typed data and context
            expect(prepared.typedData.message.expiry).toBe(customExpiry)
            expect(BigInt(prepared.context.quote.quotes[0].intent.expiry)).toBe(customExpiry)

            // Mutate the context expiry to the past, then sign with matching expired expiry —
            // same pattern as the other tests. This verifies the send-side rejection.
            const expiredExpiry = BigInt(Math.floor(Date.now() / 1000) - 3600)
            prepared.context.quote.quotes[0].intent.expiry = expiredExpiry.toString()

            const signature = await walletClient.signTypedData({
                domain: prepared.typedData.domain,
                types: prepared.typedData.types,
                primaryType: prepared.typedData.primaryType,
                message: { ...prepared.typedData.message, expiry: expiredExpiry },
            })

            await expect(
                transport.request('wallet_sendPreparedCalls', {
                    context: prepared.context,
                    signature,
                }),
            ).rejects.toMatchObject({
                code: -32008,
                message: expect.stringContaining('Intent expired'),
            })
        },
    )

    it('should reject intent that has already expired', { timeout: 30000 }, async () => {
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

        // 2. Prepare calls and override intent expiry to an ALREADY EXPIRED timestamp
        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        // Expiry in the past (1 hour ago)
        const expiredExpiry = BigInt(Math.floor(Date.now() / 1000) - 3600)
        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
        })
        prepared.context.quote.quotes[0].intent.expiry = expiredExpiry.toString()

        // Sign typed data with matching expired expiry
        const signature = await walletClient.signTypedData({
            domain: prepared.typedData.domain,
            types: prepared.typedData.types,
            primaryType: 'Intent',
            message: {
                ...(prepared.typedData.message as Record<string, unknown>),
                expiry: expiredExpiry,
            },
        })

        // 3. Submit the expired intent directly via JSON-RPC (quote-wrapped context with chainId)
        await expect(
            transport.request('wallet_sendPreparedCalls', {
                context: prepared.context,
                signature,
            }),
        ).rejects.toMatchObject({
            code: -32008,
            message: expect.stringContaining('Intent expired'),
        })
    })

    it('should reject intent expiring within buffer period', { timeout: 30000 }, async () => {
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

        // 2. Prepare calls and override intent expiry very soon (within 30 second buffer)
        const walletClient = createWalletClient({
            account,
            chain: testChain,
            transport: http(ANVIL_RPC_URL),
        })

        // Expiry in 10 seconds (within default 30 second buffer)
        const soonExpiry = BigInt(Math.floor(Date.now() / 1000) + 10)
        const prepared = await client.prepareCalls({
            from: account.address,
            calls: [{ target: recipient, value: parseEther('0.1'), data: '0x' }],
        })
        prepared.context.quote.quotes[0].intent.expiry = soonExpiry.toString()

        const signature = await walletClient.signTypedData({
            domain: prepared.typedData.domain,
            types: prepared.typedData.types,
            primaryType: 'Intent',
            message: {
                ...(prepared.typedData.message as Record<string, unknown>),
                expiry: soonExpiry,
            },
        })

        // 3. Submit the intent
        await expect(
            transport.request('wallet_sendPreparedCalls', {
                context: prepared.context,
                signature,
            }),
        ).rejects.toMatchObject({
            code: -32008,
            message: expect.stringContaining('Intent expired'),
        })
    })

    it('should accept intent with valid future expiry', { timeout: 30000 }, async () => {
        // This is a sanity check - valid intents should still work
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)

        await setBalance(account.address, parseEther('10'))

        const createResult = await client.upgradeAccount({
            accountAddress: account.address,
            signerKey: privateKey,
            delegation: contracts.accountProxy,
        })
        expect(createResult.success).toBe(true)

        // Use the normal prepareCalls flow which sets a valid expiry
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

        // Should succeed - no expiry error
        expect(result.id).toBeDefined()

        // Wait for confirmation
        const status = await waitForBundle(client, { id: result.id })
        expect(status.statusCode).toBe(200)
    })
})
