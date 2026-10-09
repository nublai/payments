/**
 * Test 8: wallet_verifySignature RPC Method
 *
 * Verifies the wallet_verifySignature RPC method correctly validates signatures:
 * 1. Non-delegated account returns valid=false
 * 2. Valid signature from superAdmin key returns valid=true with proof
 * 3. Invalid signature (wrong key) returns valid=false
 * 4. Signature over wrong digest returns valid=false
 * 5. Signature from normal key (non-superAdmin) returns valid=false
 * 6. Chain ID mismatch throws error
 * 7. Invalid digest format throws error
 * 8. Invalid address format throws error
 */

import { describe, it, expect } from 'vitest'
import { keccak256, encodeAbiParameters, serializeSignature, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts'

import { computeKeyHash, createJsonRpcTransport, computeErc1271Digest } from '../../src'
import { ANVIL_RPC_URL, RELAYER_URL, testChain, TEST_CONTRACTS } from '../setup'
import { setBalance } from '../helpers/anvil'
import { createRelayerTestAuthSigner, createRelayerTestClient } from '../helpers/client'

/**
 * Response types for wallet_verifySignature
 */
interface VerifySignatureResult {
    valid: boolean
    proof: {
        account: Address
        key_hash: Hex
    } | null
}

describe('wallet_verifySignature', () => {
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

    it('should return valid=false for non-delegated account', async () => {
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        const digest = keccak256(new TextEncoder().encode('test message'))
        const chainId = `0x${(client.chain?.id ?? 31337).toString(16)}`

        const result = await transport.request<VerifySignatureResult>('wallet_verifySignature', {
            address: account.address,
            digest,
            signature: '0x' + 'ab'.repeat(65),
            chain_id: chainId,
        })

        expect(result.valid).toBe(false)
        expect(result.proof).toBeNull()
    })

    it(
        'should return valid=true with proof for valid superAdmin signature',
        { timeout: 30000 },
        async () => {
            // #given - create a delegated account with a separate superAdmin signer
            // IMPORTANT: The superAdmin signer must be a DIFFERENT address than the account
            // because the account has delegation code, which causes SignatureCheckerLib
            // to call isValidSignature recursively instead of doing ECDSA recovery.
            const accountPrivateKey = generatePrivateKey()
            const accountAddress = privateKeyToAccount(accountPrivateKey)

            const signerPrivateKey = generatePrivateKey()
            const signerAccount = privateKeyToAccount(signerPrivateKey)

            await setBalance(accountAddress.address, 1_000_000_000_000_000_000n)

            const encodedSuperAdminKey = encodeAbiParameters(
                [{ type: 'address' }],
                [signerAccount.address], // Use separate signer, not account address
            )

            const createResult = await client.upgradeAccount({
                accountAddress: accountAddress.address,
                signerKey: accountPrivateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'admin',
                        publicKey: encodedSuperAdminKey,
                        permissions: [],
                    },
                ],
            })

            expect(createResult.success).toBe(true)
            await new Promise((resolve) => setTimeout(resolve, 2000))

            const originalDigest = keccak256(new TextEncoder().encode('test message'))
            const erc1271Digest = computeErc1271Digest(originalDigest, accountAddress.address)

            // Sign the ERC-1271 transformed digest with the SIGNER key (not account key)
            const signatureObj = await sign({ hash: erc1271Digest, privateKey: signerPrivateKey })
            const signature = serializeSignature(signatureObj)

            const chainId = `0x${(client.chain?.id ?? 31337).toString(16)}`

            const result = await transport.request<VerifySignatureResult>(
                'wallet_verifySignature',
                {
                    address: accountAddress.address,
                    digest: originalDigest,
                    signature,
                    chain_id: chainId,
                },
            )

            expect(result.valid).toBe(true)
            expect(result.proof).not.toBeNull()
            expect(result.proof?.account.toLowerCase()).toBe(accountAddress.address.toLowerCase())

            // Verify key hash matches
            const expectedKeyHash = computeKeyHash('secp256k1', encodedSuperAdminKey)
            expect(result.proof?.key_hash).toBe(expectedKeyHash)
        },
    )

    it('should return valid=false for invalid signature', { timeout: 30000 }, async () => {
        // #given - create a delegated account with a SEPARATE signer
        // (signer must differ from account to avoid SignatureCheckerLib recursive call)
        const accountPrivateKey = generatePrivateKey()
        const accountAddress = privateKeyToAccount(accountPrivateKey)

        const signerPrivateKey = generatePrivateKey()
        const signerAccount = privateKeyToAccount(signerPrivateKey)

        await setBalance(accountAddress.address, 1_000_000_000_000_000_000n)

        const encodedSuperAdminKey = encodeAbiParameters(
            [{ type: 'address' }],
            [signerAccount.address],
        )

        const createResult = await client.upgradeAccount({
            accountAddress: accountAddress.address,
            signerKey: accountPrivateKey,
            delegation: contracts.accountProxy,
            authorizeKeys: [
                {
                    expiry: '0',
                    type: 'secp256k1',
                    role: 'admin',
                    publicKey: encodedSuperAdminKey,
                    permissions: [],
                },
            ],
        })

        expect(createResult.success).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 2000))

        // #given - create an invalid signature (signed by a THIRD key, not the registered signer)
        const wrongPrivateKey = generatePrivateKey()
        const originalDigest = keccak256(new TextEncoder().encode('test message'))
        const erc1271Digest = computeErc1271Digest(originalDigest, accountAddress.address)

        // Sign with wrong key (neither account nor registered signer)
        const invalidSignatureObj = await sign({
            hash: erc1271Digest,
            privateKey: wrongPrivateKey,
        })

        const invalidSignature = serializeSignature(invalidSignatureObj)

        const chainId = `0x${(client.chain?.id ?? 31337).toString(16)}`

        const result = await transport.request<VerifySignatureResult>('wallet_verifySignature', {
            address: accountAddress.address,
            digest: originalDigest,
            signature: invalidSignature,
            chain_id: chainId,
        })

        expect(result.valid).toBe(false)
        expect(result.proof).toBeNull()
    })

    it(
        'should return valid=false for signature over wrong digest',
        { timeout: 30000 },
        async () => {
            // #given - create a delegated account with a SEPARATE signer
            // (signer must differ from account to avoid SignatureCheckerLib recursive call)
            const accountPrivateKey = generatePrivateKey()
            const accountAddress = privateKeyToAccount(accountPrivateKey)

            const signerPrivateKey = generatePrivateKey()
            const signerAccount = privateKeyToAccount(signerPrivateKey)

            await setBalance(accountAddress.address, 1_000_000_000_000_000_000n)

            const encodedSuperAdminKey = encodeAbiParameters(
                [{ type: 'address' }],
                [signerAccount.address],
            )

            const createResult = await client.upgradeAccount({
                accountAddress: accountAddress.address,
                signerKey: accountPrivateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'admin',
                        publicKey: encodedSuperAdminKey,
                        permissions: [],
                    },
                ],
            })

            expect(createResult.success).toBe(true)
            await new Promise((resolve) => setTimeout(resolve, 2000))

            // #given - sign a different digest than what we'll verify
            const signedDigest = keccak256(new TextEncoder().encode('message A'))
            const verifyDigest = keccak256(new TextEncoder().encode('message B'))

            const erc1271Digest = computeErc1271Digest(signedDigest, accountAddress.address)
            const signatureObj = await sign({ hash: erc1271Digest, privateKey: signerPrivateKey })
            const signature = serializeSignature(signatureObj)

            const chainId = `0x${(client.chain?.id ?? 31337).toString(16)}`

            const result = await transport.request<VerifySignatureResult>(
                'wallet_verifySignature',
                {
                    address: accountAddress.address,
                    digest: verifyDigest,
                    signature,
                    chain_id: chainId,
                },
            )

            expect(result.valid).toBe(false)
            expect(result.proof).toBeNull()
        },
    )

    it(
        'should return valid=false for signature from normal key (non-superAdmin)',
        { timeout: 30000 },
        async () => {
            // #given - create a delegated account with a normal key (not superAdmin)
            const accountPrivateKey = generatePrivateKey()
            const accountAddress = privateKeyToAccount(accountPrivateKey)

            const normalKeyPrivateKey = generatePrivateKey()
            const normalKeyAccount = privateKeyToAccount(normalKeyPrivateKey)

            await setBalance(accountAddress.address, 1_000_000_000_000_000_000n)

            const encodedNormalKey = encodeAbiParameters(
                [{ type: 'address' }],
                [normalKeyAccount.address],
            )

            const createResult = await client.upgradeAccount({
                accountAddress: accountAddress.address,
                signerKey: accountPrivateKey,
                delegation: contracts.accountProxy,
                authorizeKeys: [
                    {
                        expiry: '0',
                        type: 'secp256k1',
                        role: 'normal', // NOT admin - this is a session key
                        publicKey: encodedNormalKey,
                        permissions: [],
                    },
                ],
            })

            expect(createResult.success).toBe(true)
            await new Promise((resolve) => setTimeout(resolve, 2000))

            // #given - sign correctly with the normal key
            const originalDigest = keccak256(new TextEncoder().encode('test message'))
            const erc1271Digest = computeErc1271Digest(originalDigest, accountAddress.address)

            const signatureObj = await sign({
                hash: erc1271Digest,
                privateKey: normalKeyPrivateKey,
            })

            const signature = serializeSignature(signatureObj)

            const chainId = `0x${(client.chain?.id ?? 31337).toString(16)}`

            // #when - verify signature
            const result = await transport.request<VerifySignatureResult>(
                'wallet_verifySignature',
                {
                    address: accountAddress.address,
                    digest: originalDigest,
                    signature,
                    chain_id: chainId,
                },
            )

            // #then - should fail because only superAdmin keys are accepted
            expect(result.valid).toBe(false)
            expect(result.proof).toBeNull()
        },
    )

    it('should throw error for chain ID mismatch', async () => {
        // #given
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        const digest = keccak256(new TextEncoder().encode('test message'))
        const wrongChainId = '0x1' // mainnet, not local anvil

        // #when / #then - should throw RPC error
        await expect(
            transport.request<VerifySignatureResult>('wallet_verifySignature', {
                address: account.address,
                digest,
                signature: '0x' + 'ab'.repeat(65),
                chain_id: wrongChainId,
            }),
        ).rejects.toThrow(/Unsupported chain ID|Chain ID mismatch/)
    })

    it('should throw error for invalid digest format', async () => {
        // #given
        const privateKey = generatePrivateKey()
        const account = privateKeyToAccount(privateKey)
        const invalidDigest = '0xabcd' // Not 32 bytes
        const chainId = `0x${(client.chain?.id ?? 31337).toString(16)}`

        // #when / #then - should throw RPC error
        await expect(
            transport.request<VerifySignatureResult>('wallet_verifySignature', {
                address: account.address,
                digest: invalidDigest,
                signature: '0x' + 'ab'.repeat(65),
                chain_id: chainId,
            }),
        ).rejects.toThrow(/Invalid digest format/)
    })

    it('should throw error for invalid address format', async () => {
        // #given
        const digest = keccak256(new TextEncoder().encode('test message'))
        const invalidAddress = '0xinvalid'
        const chainId = `0x${(client.chain?.id ?? 31337).toString(16)}`

        // #when / #then - should throw RPC error
        await expect(
            transport.request<VerifySignatureResult>('wallet_verifySignature', {
                address: invalidAddress,
                digest,
                signature: '0x' + 'ab'.repeat(65),
                chain_id: chainId,
            }),
        ).rejects.toThrow(/Invalid address/)
    })
})
