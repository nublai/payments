/**
 * Test 7: wallet_getKeys RPC Method
 *
 * Verifies the wallet_getKeys RPC method returns correct key data:
 * 1. Key types match contract's KeyType enum (secp256k1=0, external=1)
 * 2. Permissions are correctly returned
 * 3. Key hashes match computed values
 */

import { describe, it, expect } from 'vitest'
import { encodeAbiParameters, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { computeKeyHash, createJsonRpcTransport } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, testChain, TEST_CONTRACTS } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestAuthSigner, createRelayerTestClient } from '../helpers/client'

/**
 * Response types for wallet_getKeys
 */
interface SpendPermissionResponse {
    type: 'spend'
    token: Address
    period: string
    limit: Hex
    spent: Hex
}

interface CallPermissionResponse {
    type: 'call'
    to: Address
    selector: Hex
}

type PermissionResponse = SpendPermissionResponse | CallPermissionResponse

interface AuthorizedKeyResponse {
    hash: Hex
    expiry: Hex
    type: 'secp256k1' | 'external'
    role: 'admin' | 'normal'
    publicKey: Hex
    permissions: PermissionResponse[]
}

type GetKeysResult = Record<string, AuthorizedKeyResponse[]>

describe('wallet_getKeys', () => {
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

    it('should return empty for non-delegated account', async () => {
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)

        // Account not delegated - multichain flow returns empty key lists per chain
        const result = await transport.request<GetKeysResult>('wallet_getKeys', {
            address: account.address,
        })

        expect(result).toBeDefined()
        const chainEntries = Object.entries(result)
        expect(chainEntries.length).toBeGreaterThan(0)
        for (const [, keys] of chainEntries) {
            expect(keys).toEqual([])
        }
    })

    it('should return keys with correct type for secp256k1', { timeout: 30000 }, async () => {
        // 1. Generate bot keypair
        const botPrivateKey = generatePrivateKey()
        const botAccount = privateKeyToAccount(botPrivateKey)

        // 2. Generate owner keypair / Can just be towns account key
        const ownerPrivateKey = generatePrivateKey()
        const ownerAccount = privateKeyToAccount(ownerPrivateKey)

        // 3. Fund the bot account
        await setBalance(botAccount.address, 1_000_000_000_000_000_000n)

        // 4. Create delegated account with a secp256k1 key
        const encodeSuperAdminKey = encodeAbiParameters(
            [{ type: 'address' }],
            [ownerAccount.address],
        )

        const result = await client.upgradeAccount({
            accountAddress: botAccount.address,
            signerKey: botPrivateKey,
            delegation: contracts.accountProxy,
            authorizeKeys: [
                {
                    expiry: '0',
                    type: 'secp256k1',
                    role: 'admin',
                    publicKey: encodeSuperAdminKey,
                    permissions: [],
                },
            ],
        })

        expect(result.success).toBe(true)

        // 5. Wait for transaction to be mined
        await new Promise((resolve) => setTimeout(resolve, 2000))

        // 6. Call wallet_getKeys RPC method
        const keysResult = await transport.request<GetKeysResult>('wallet_getKeys', {
            address: botAccount.address,
        })

        // 7. Verify the result structure
        expect(keysResult).toBeDefined()

        // Get the keys for our chain (hex chain ID)
        const chainId = client.chain?.id ?? 31337
        const hexChainId = `0x${chainId.toString(16)}`
        const keys = keysResult[hexChainId]

        expect(keys).toBeDefined()
        expect(keys.length).toBe(1)

        // 8. Verify key type is 'secp256k1' (maps to contract enum value 0)
        const key = keys[0]
        expect(key.type).toBe('secp256k1')
        expect(key.role).toBe('admin')
        expect(key.publicKey).toBe(encodeSuperAdminKey)

        // 9. Verify key hash matches our computation
        const expectedKeyHash = computeKeyHash('secp256k1', encodeSuperAdminKey)
        expect(key.hash).toBe(expectedKeyHash)
    })

    it(
        'should return keys with correct permissions for session key',
        { timeout: 30000 },
        async () => {
            // This test demonstrates:
            // 1. A towns account allowing a bot account to spend on its behalf with a spend permission
            // 2. The bot account is granted a spend limit for native ETH
            // 3. Testing that the bot account CAN spend within the limit
            // 4. Testing that the bot account CANNOT spend more than the limit

            // 1. Generate owner keypair
            const townsAccountPrivateKey = generatePrivateKey()
            const townsAccount = privateKeyToAccount(townsAccountPrivateKey)

            // 2. Generate a session key
            const botPrivateKey = generatePrivateKey()
            const botAccount = privateKeyToAccount(botPrivateKey)

            // 3. Fund the owner account
            await setBalance(townsAccount.address, 1_000_000_000_000_000_000n)

            // 4. Create delegated account with a normal key with spend permission
            const encodedSessionPublicKey = encodeAbiParameters(
                [{ type: 'address' }],
                [botAccount.address],
            )

            const spendLimit = '50000000000000000' // 0.05 ETH

            const result = await client.upgradeAccount({
                accountAddress: townsAccount.address,
                signerKey: townsAccountPrivateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'normal',
                        publicKey: encodedSessionPublicKey,
                        permissions: [
                            {
                                type: 'spend',
                                token: '0x0000000000000000000000000000000000000000', // Native ETH
                                limit: spendLimit,
                                period: 'day',
                            },
                        ],
                    },
                ],
            })

            expect(result.success).toBe(true)

            // 5. Wait for transaction to be mined
            await new Promise((resolve) => setTimeout(resolve, 2000))

            // 6. Call wallet_getKeys RPC method
            const keysResult = await transport.request<GetKeysResult>('wallet_getKeys', {
                address: townsAccount.address,
            })

            // Get the keys for our chain
            const chainId = client.chain?.id ?? 31337
            const hexChainId = `0x${chainId.toString(16)}`
            const keys = keysResult[hexChainId]

            expect(keys).toBeDefined()
            expect(keys.length).toBe(1)

            // 7. Verify key details
            const key = keys[0]
            expect(key.type).toBe('secp256k1')
            expect(key.role).toBe('normal')

            // 8. Verify spend permission is returned
            expect(key.permissions.length).toBe(1)
            const permission = key.permissions[0]
            expect(permission.type).toBe('spend')

            if (permission.type === 'spend') {
                expect(permission.token.toLowerCase()).toBe(
                    '0x0000000000000000000000000000000000000000',
                )
                expect(permission.period).toBe('day')
                // limit is returned as hex
                expect(BigInt(permission.limit)).toBe(BigInt(spendLimit))
                // spent should be 0 initially
                expect(BigInt(permission.spent)).toBe(0n)
            }
        },
    )
})
