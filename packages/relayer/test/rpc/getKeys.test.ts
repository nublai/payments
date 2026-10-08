/**
 * wallet_getKeys must fail the RPC when permission lookup fails,
 * instead of returning keys with an empty permission list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RpcContext } from '../../src/rpc/types'
import { CONTRACT_ERROR, RpcError } from '../../src/rpc/errors'

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
    toHexChainId: (chainId: number) => `0x${chainId.toString(16)}`,
}))

vi.mock('../../src/config', () => ({
    getChainIds: () => [31337],
    getChainConfig: () => ({
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
        contracts: {},
    }),
}))

vi.mock('../../src/lib/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}))

import { handleGetKeys } from '../../src/rpc/methods/getKeys'

const account = '0x1234567890123456789012345678901234567890'

const keyHash = `0x${'ab'.repeat(32)}`

const createMockCtx = (): RpcContext => ({
    env: {
        RPC_URL: 'http://127.0.0.1:8545',
        CHAIN_IDS: '31337',
    },
})

describe('wallet_getKeys permission lookup', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetCode.mockResolvedValue('0xef0100')
    })

    it('returns a JSON-RPC error when spendAndExecuteInfos fails', async () => {
        mockReadContract.mockImplementation(async (args: { functionName?: string }) => {
            if (args.functionName === 'getKeys') {
                return [
                    [
                        {
                            expiry: 0n,
                            keyType: 0,
                            isSuperAdmin: false,
                            publicKey: '0x',
                        },
                    ],
                    [keyHash],
                ]
            }

            throw new Error('spendAndExecuteInfos reverted')
        })

        const ctx = createMockCtx()
        const params = [{ address: account, chainIds: ['0x7a69'] }]

        await expect(handleGetKeys(params, ctx)).rejects.toBeInstanceOf(RpcError)
        await expect(handleGetKeys(params, ctx)).rejects.toMatchObject({
            code: CONTRACT_ERROR,
            message: 'Failed to read key permissions',
        })
    })

    it('returns call and spend permissions when the lookup succeeds', async () => {
        const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

        const packedTransfer = `0x${(
            (BigInt(usdc) << 96n) |
            BigInt('0xa9059cbb')
        )
            .toString(16)
            .padStart(64, '0')}`

        mockReadContract.mockImplementation(async (args: { functionName?: string }) => {
            if (args.functionName === 'getKeys') {
                return [
                    [
                        {
                            expiry: 0n,
                            keyType: 0,
                            isSuperAdmin: false,
                            publicKey: '0x',
                        },
                    ],
                    [keyHash],
                ]
            }

            return [
                [
                    [
                        {
                            token: usdc,
                            period: 2,
                            limit: 10_000_000n,
                            spent: 0n,
                            lastUpdated: 0n,
                            currentSpent: 0n,
                            current: 0n,
                        },
                    ],
                ],
                [[packedTransfer]],
            ]
        })

        const result = await handleGetKeys(
            [{ address: account, chainIds: ['0x7a69'] }],
            createMockCtx(),
        )

        const keys = result['0x7a69']
        expect(keys).toHaveLength(1)
        expect(keys?.[0]?.permissions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ type: 'call', selector: '0xa9059cbb' }),
                expect.objectContaining({ type: 'spend', period: 'day' }),
            ]),
        )
        expect(keys?.[0]?.permissions).not.toEqual([])
    })
})
