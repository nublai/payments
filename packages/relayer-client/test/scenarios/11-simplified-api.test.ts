/**
 * Test 11: Simplified API
 *
 * Verifies the new simplified relayer-client API:
 * 1. prepareCalls → sign → sendPreparedCalls → getCallsStatus flow
 * 2. upgradeAccount (renamed from createAccount)
 * 3. getKeys RPC method
 * 4. verifySignature RPC method
 */

import { describe, it, expect } from 'vitest'
import {
    createWalletClient,
    http,
    parseEther,
    encodeAbiParameters,
    keccak256,
    serializeSignature,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts'

import { waitForBundle, wrapSignature, computeKeyHash, computeErc1271Digest } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, TEST_CONTRACTS, testChain } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestClient } from '../helpers/client'

describe('Simplified API', () => {
    const client = createRelayerTestClient({
        chain: testChain,
        rpcUrl: ANVIL_RPC_URL,
        relayerUrl: RELAYER_URL,
    })

    const contracts = TEST_CONTRACTS
    const recipient = '0x000000000000000000000000000000000000dEaD'

    it(
        'should execute ETH transfer using new prepareCalls → sendPreparedCalls flow',
        { timeout: 30000 },
        async () => {
            // 1. Setup account
            const privateKey = generatePrivateKey()
            const account = privateKeyToAccount(privateKey)
            const initialBalance = parseEther('10')
            await setBalance(account.address, initialBalance)

            // 2. Upgrade EOA to delegated account (new API name)
            const upgradeResult = await client.upgradeAccount({
                accountAddress: account.address,
                signerKey: privateKey,
                delegation: contracts.accountProxy,
            })
            expect(upgradeResult.success).toBe(true)

            // Verify upgrade was gasless
            const balanceAfterUpgrade = await client.getBalance({ address: account.address })
            expect(balanceAfterUpgrade).toBe(initialBalance)

            // 3. Prepare calls (new API)
            const transferAmount = parseEther('1')
            const prepared = await client.prepareCalls({
                from: account.address,
                calls: [{ target: recipient, value: transferAmount, data: '0x' }],
            })

            expect(prepared.context).toBeDefined()
            expect(prepared.digest).toBeDefined()
            expect(prepared.typedData).toBeDefined()

            // 4. Sign with viem directly (user responsibility)
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

            // 5. Send prepared calls (new API)
            const sendResult = await client.sendPreparedCalls({
                context: prepared.context,
                signature,
            })
            expect(sendResult.id).toBeDefined()

            // 6. Check status via getCallsStatus (new API)
            const statusResult = await client.getCallsStatus({ id: sendResult.id })
            expect(statusResult.success).toBe(true)
            // Status might be pending or confirmed at this point

            // 7. Wait for bundle using standalone utility
            const finalStatus = await waitForBundle(client, { id: sendResult.id })
            expect(finalStatus.status).toBe('confirmed')
            expect(finalStatus.receipt?.transactionHash).toBeDefined()

            // 8. Verify transfer was gasless
            const balanceAfterTransfer = await client.getBalance({ address: account.address })
            expect(balanceAfterTransfer).toBe(initialBalance - transferAmount)
        },
    )

    it('should get keys using new getKeys method', { timeout: 30000 }, async () => {
        // 1. Setup account with an authorized key
        const ownerPrivateKey = generatePrivateKey()
        const ownerAccount = privateKeyToAccount(ownerPrivateKey)

        const signerPrivateKey = generatePrivateKey()
        const signerAccount = privateKeyToAccount(signerPrivateKey)

        await setBalance(ownerAccount.address, parseEther('1'))

        const encodedKey = encodeAbiParameters([{ type: 'address' }], [signerAccount.address])

        // 2. Upgrade with authorized key
        const upgradeResult = await client.upgradeAccount({
            accountAddress: ownerAccount.address,
            signerKey: ownerPrivateKey,
            delegation: contracts.accountProxy,
            authorizeKeys: [
                {
                    expiry: '0',
                    type: 'secp256k1',
                    role: 'admin',
                    publicKey: encodedKey,
                    permissions: [],
                },
            ],
        })
        expect(upgradeResult.success).toBe(true)

        // Wait for tx to be mined
        await new Promise((resolve) => setTimeout(resolve, 2000))

        // 3. Get keys using new API
        const keysResult = await client.getKeys({ address: ownerAccount.address })
        expect(keysResult).toBeDefined()

        // Get keys for our chain
        const chainId = client.chain?.id ?? 31337
        const hexChainId = `0x${chainId.toString(16)}`
        const keys = keysResult[hexChainId]

        expect(keys).toBeDefined()
        expect(keys.length).toBe(1)
        expect(keys[0].type).toBe('secp256k1')
        expect(keys[0].role).toBe('admin')

        // Verify hash matches
        const expectedHash = computeKeyHash('secp256k1', encodedKey)
        expect(keys[0].hash).toBe(expectedHash)
    })

    it('should verify signature using new verifySignature method', { timeout: 30000 }, async () => {
        // 1. Setup account with an authorized admin key
        const accountPrivateKey = generatePrivateKey()
        const accountAddress = privateKeyToAccount(accountPrivateKey)

        const signerPrivateKey = generatePrivateKey()
        const signerAccount = privateKeyToAccount(signerPrivateKey)

        await setBalance(accountAddress.address, parseEther('1'))

        const encodedKey = encodeAbiParameters([{ type: 'address' }], [signerAccount.address])

        // 2. Upgrade with admin key
        const upgradeResult = await client.upgradeAccount({
            accountAddress: accountAddress.address,
            signerKey: accountPrivateKey,
            delegation: contracts.accountProxy,
            authorizeKeys: [
                {
                    expiry: '0',
                    type: 'secp256k1',
                    role: 'admin',
                    publicKey: encodedKey,
                    permissions: [],
                },
            ],
        })
        expect(upgradeResult.success).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 2000))

        // 3. Sign a message using ERC-1271 transform
        const originalDigest = keccak256(new TextEncoder().encode('test message'))
        const erc1271Digest = computeErc1271Digest(originalDigest, accountAddress.address)
        const signatureObj = await sign({ hash: erc1271Digest, privateKey: signerPrivateKey })
        const signature = serializeSignature(signatureObj)

        // 4. Verify using new API
        const result = await client.verifySignature({
            address: accountAddress.address,
            digest: originalDigest,
            signature,
        })

        expect(result.valid).toBe(true)
        expect(result.proof).not.toBeNull()
        expect(result.proof?.account.toLowerCase()).toBe(accountAddress.address.toLowerCase())

        // Verify key hash matches
        const expectedKeyHash = computeKeyHash('secp256k1', encodedKey)
        expect(result.proof?.keyHash).toBe(expectedKeyHash)
    })

    it(
        'should support wrapSignature for authorized key transfers',
        { timeout: 30000 },
        async () => {
            // 1. Setup account with session key
            const ownerPrivateKey = generatePrivateKey()
            const ownerAccount = privateKeyToAccount(ownerPrivateKey)

            const sessionPrivateKey = generatePrivateKey()
            const sessionAccount = privateKeyToAccount(sessionPrivateKey)

            const initialBalance = parseEther('10')
            await setBalance(ownerAccount.address, initialBalance)

            const encodedSessionKey = encodeAbiParameters(
                [{ type: 'address' }],
                [sessionAccount.address],
            )

            const keyHash = computeKeyHash('secp256k1', encodedSessionKey)

            // 2. Upgrade with session key
            const upgradeResult = await client.upgradeAccount({
                accountAddress: ownerAccount.address,
                signerKey: ownerPrivateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'admin',
                        publicKey: encodedSessionKey,
                        permissions: [],
                    },
                ],
            })
            expect(upgradeResult.success).toBe(true)

            // 3. Prepare calls
            const transferAmount = parseEther('1')
            const prepared = await client.prepareCalls({
                from: ownerAccount.address,
                calls: [{ target: recipient, value: transferAmount, data: '0x' }],
            })

            // 4. Sign with session key
            const sessionWallet = createWalletClient({
                account: sessionAccount,
                chain: testChain,
                transport: http(ANVIL_RPC_URL),
            })

            const rawSignature = await sessionWallet.signTypedData({
                domain: prepared.typedData.domain,
                types: prepared.typedData.types,
                primaryType: prepared.typedData.primaryType,
                message: prepared.typedData.message,
            })

            // 5. Wrap signature with keyHash using the utility
            const wrappedSignature = wrapSignature(rawSignature, keyHash)

            // 6. Send with wrapped signature
            const sendResult = await client.sendPreparedCalls({
                context: prepared.context,
                signature: wrappedSignature,
            })
            expect(sendResult.id).toBeDefined()

            // 7. Wait and verify
            const status = await waitForBundle(client, { id: sendResult.id })
            expect(status.status).toBe('confirmed')

            const balanceAfter = await client.getBalance({ address: ownerAccount.address })
            expect(balanceAfter).toBe(initialBalance - transferAmount)
        },
    )
})
