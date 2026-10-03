/**
 * Unit tests for wallet_verifySignature RPC method
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RpcContext } from '../../src/rpc/types'
import { RpcError, INVALID_PARAMS } from '../../src/rpc/errors'

const { mockGetCode, mockReadContract } = vi.hoisted(() => ({
    mockGetCode: vi.fn(),
    mockReadContract: vi.fn(),
}))

vi.mock('../../src/lib/viem-utils', () => ({
    createRelayerPublicClient: vi.fn().mockReturnValue({
        getCode: mockGetCode,
        readContract: mockReadContract,
    }),
    hasCode: (code: string | undefined) => !!code && code !== '0x' && code.length > 2,
}))

// Import after mocks are set up
import { handleVerifySignature } from '../../src/rpc/methods/verifySignature'

// Mock config
vi.mock('../../src/config', () => ({
    getChainIds: () => [8453],
    getChainConfig: () => ({
        rpcUrl: 'https://example.com/rpc',
        chainId: 8453,
        contracts: {
            account: '0x1234567890123456789012345678901234567890',
            orchestrator: '0x3456789012345678901234567890123456789012',
        },
    }),
}))

// Mock logger
vi.mock('../../src/lib/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}))

// Create mock context
const createMockCtx = (): RpcContext => ({
    env: {
        RPC_URL: 'https://example.com/rpc',
        CHAIN_IDS: '8453',
    },
})

// Test data
const validAddress = '0x1234567890123456789012345678901234567890'
const validDigest = '0x' + '1'.repeat(64)
const validSignature = '0x' + 'ab'.repeat(65) // 65 bytes
const validChainId = '0x2105' // 8453 in hex

describe('wallet_verifySignature', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    describe('parameter validation', () => {
        it('should throw INVALID_PARAMS when address is missing', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                { digest: validDigest, signature: validSignature, chain_id: validChainId },
            ]

            // #when / #then
            await expect(handleVerifySignature(params, ctx)).rejects.toThrow(RpcError)
            await expect(handleVerifySignature(params, ctx)).rejects.toMatchObject({
                code: INVALID_PARAMS,
                message: 'Missing required parameter: address',
            })
        })

        it('should throw INVALID_PARAMS when digest is missing', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                { address: validAddress, signature: validSignature, chain_id: validChainId },
            ]

            // #when / #then
            await expect(handleVerifySignature(params, ctx)).rejects.toThrow(RpcError)
            await expect(handleVerifySignature(params, ctx)).rejects.toMatchObject({
                code: INVALID_PARAMS,
                message: 'Missing required parameter: digest',
            })
        })

        it('should throw INVALID_PARAMS when signature is missing', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [{ address: validAddress, digest: validDigest, chain_id: validChainId }]

            // #when / #then
            await expect(handleVerifySignature(params, ctx)).rejects.toThrow(RpcError)
            await expect(handleVerifySignature(params, ctx)).rejects.toMatchObject({
                code: INVALID_PARAMS,
                message: 'Missing required parameter: signature',
            })
        })

        it('should throw INVALID_PARAMS when chain_id is missing', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                { address: validAddress, digest: validDigest, signature: validSignature },
            ]

            // #when / #then
            await expect(handleVerifySignature(params, ctx)).rejects.toThrow(RpcError)
            await expect(handleVerifySignature(params, ctx)).rejects.toMatchObject({
                code: INVALID_PARAMS,
                message: 'Missing required parameter: chain_id',
            })
        })

        it('should throw INVALID_PARAMS for invalid address format', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                {
                    address: '0xinvalid',
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]

            // #when / #then
            await expect(handleVerifySignature(params, ctx)).rejects.toThrow(RpcError)
            await expect(handleVerifySignature(params, ctx)).rejects.toMatchObject({
                code: INVALID_PARAMS,
                message: expect.stringContaining('Invalid address'),
            })
        })

        it('should throw INVALID_PARAMS for invalid digest format', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                {
                    address: validAddress,
                    digest: '0x1234', // Not 32 bytes
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]

            // #when / #then
            await expect(handleVerifySignature(params, ctx)).rejects.toThrow(RpcError)
            await expect(handleVerifySignature(params, ctx)).rejects.toMatchObject({
                code: INVALID_PARAMS,
                message: 'Invalid digest format: must be 32 bytes',
            })
        })

        it('should throw INVALID_PARAMS for chain_id mismatch', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: '0x1', // Ethereum mainnet, not Base
                },
            ]

            // #when / #then
            await expect(handleVerifySignature(params, ctx)).rejects.toThrow(RpcError)
            await expect(handleVerifySignature(params, ctx)).rejects.toMatchObject({
                code: INVALID_PARAMS,
            })
        })
    })

    describe('delegation check', () => {
        it('should return valid=false when account has no code (not delegated)', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]
            mockGetCode.mockResolvedValue('0x')

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result).toEqual({ valid: false, proof: null })
        })

        it('should return valid=false when account code is undefined', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]
            mockGetCode.mockResolvedValue(undefined)

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result).toEqual({ valid: false, proof: null })
        })
    })

    describe('key resolution', () => {
        it('should return valid=false when getKeys fails', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]
            mockGetCode.mockResolvedValue('0xef0100abcd') // Has delegation code
            mockReadContract.mockRejectedValue(new Error('Contract call failed'))

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result).toEqual({ valid: false, proof: null })
        })

        it('should return valid=false when no superAdmin keys exist', async () => {
            // #given
            const ctx = createMockCtx()
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]
            mockGetCode.mockResolvedValue('0xef0100abcd')
            // getKeys returns keys, none are superAdmin
            mockReadContract.mockResolvedValue([
                [{ expiry: 0, keyType: 0, isSuperAdmin: false, publicKey: '0x1234' }],
                ['0x' + '11'.repeat(32)],
            ])

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result).toEqual({ valid: false, proof: null })
        })
    })

    describe('signature verification', () => {
        it('should return valid=true with proof when signature validates', async () => {
            // #given
            const ctx = createMockCtx()
            const keyHash = '0x' + 'aa'.repeat(32)
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]

            mockGetCode.mockResolvedValue('0xef0100abcd')
            // First call: getKeys
            mockReadContract.mockResolvedValueOnce([
                [{ expiry: 0, keyType: 0, isSuperAdmin: true, publicKey: '0x1234' }],
                [keyHash],
            ])
            // Second call: unwrapAndValidateSignature
            mockReadContract.mockResolvedValueOnce([true, keyHash])

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result.valid).toBe(true)
            expect(result.proof).not.toBeNull()
            expect(result.proof?.account).toBe(validAddress)
            expect(result.proof?.key_hash).toBe(keyHash)
        })

        it('should return valid=false when signature validation fails', async () => {
            // #given
            const ctx = createMockCtx()
            const keyHash = '0x' + 'aa'.repeat(32)
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]

            mockGetCode.mockResolvedValue('0xef0100abcd')
            // First call: getKeys
            mockReadContract.mockResolvedValueOnce([
                [{ expiry: 0, keyType: 0, isSuperAdmin: true, publicKey: '0x1234' }],
                [keyHash],
            ])
            // Second call: unwrapAndValidateSignature returns invalid
            mockReadContract.mockResolvedValueOnce([false, '0x' + '00'.repeat(32)])

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result).toEqual({ valid: false, proof: null })
        })

        it('should try all superAdmin keys and return first valid', async () => {
            // #given
            const ctx = createMockCtx()
            const keyHash1 = '0x' + 'aa'.repeat(32)
            const keyHash2 = '0x' + 'bb'.repeat(32)
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]

            mockGetCode.mockResolvedValue('0xef0100abcd')
            // getKeys returns two superAdmin keys
            mockReadContract.mockResolvedValueOnce([
                [
                    { expiry: 0, keyType: 0, isSuperAdmin: true, publicKey: '0x1234' },
                    { expiry: 0, keyType: 0, isSuperAdmin: true, publicKey: '0x5678' },
                ],
                [keyHash1, keyHash2],
            ])
            // First key fails, second key succeeds
            mockReadContract.mockResolvedValueOnce([false, '0x' + '00'.repeat(32)])
            mockReadContract.mockResolvedValueOnce([true, keyHash2])

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result.valid).toBe(true)
            expect(result.proof?.key_hash).toBe(keyHash2)
        })

        it('should handle unwrapAndValidateSignature throwing error', async () => {
            // #given
            const ctx = createMockCtx()
            const keyHash = '0x' + 'aa'.repeat(32)
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]

            mockGetCode.mockResolvedValue('0xef0100abcd')
            mockReadContract.mockResolvedValueOnce([
                [{ expiry: 0, keyType: 0, isSuperAdmin: true, publicKey: '0x1234' }],
                [keyHash],
            ])
            // unwrapAndValidateSignature throws
            mockReadContract.mockRejectedValueOnce(new Error('Contract error'))

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result).toEqual({ valid: false, proof: null })
        })
    })

    describe('JSON-RPC format', () => {
        it('should handle params as array (JSON-RPC spec)', async () => {
            // #given
            const ctx = createMockCtx()
            const keyHash = '0x' + 'aa'.repeat(32)
            const params = [
                {
                    address: validAddress,
                    digest: validDigest,
                    signature: validSignature,
                    chain_id: validChainId,
                },
            ]

            mockGetCode.mockResolvedValue('0xef0100abcd')
            mockReadContract.mockResolvedValueOnce([
                [{ expiry: 0, keyType: 0, isSuperAdmin: true, publicKey: '0x1234' }],
                [keyHash],
            ])
            mockReadContract.mockResolvedValueOnce([true, keyHash])

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result.valid).toBe(true)
        })

        it('should handle params as object (direct call)', async () => {
            // #given
            const ctx = createMockCtx()
            const keyHash = '0x' + 'aa'.repeat(32)
            const params = {
                address: validAddress,
                digest: validDigest,
                signature: validSignature,
                chain_id: validChainId,
            }

            mockGetCode.mockResolvedValue('0xef0100abcd')
            mockReadContract.mockResolvedValueOnce([
                [{ expiry: 0, keyType: 0, isSuperAdmin: true, publicKey: '0x1234' }],
                [keyHash],
            ])
            mockReadContract.mockResolvedValueOnce([true, keyHash])

            // #when
            const result = await handleVerifySignature(params, ctx)

            // #then
            expect(result.valid).toBe(true)
        })
    })
})
