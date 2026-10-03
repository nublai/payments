import { describe, it, expect } from 'vitest'
import { encodeAbiParameters, keccak256, padHex, zeroAddress } from 'viem'
import { computeEscrowId } from '../../../src/escrow/computeEscrowId.js'
import type { CreateEscrowParams } from '../../../src/escrow/types.js'

const BASE_PARAMS: CreateEscrowParams = {
    buyer: '0x1111111111111111111111111111111111111111',
    seller: '0x2222222222222222222222222222222222222222',
    usdcAmount: 100_000_000n, // 100 USDC (6 decimals)
    deadline: 1800000000n,
    orderId: `0x${'ab'.repeat(32)}` as `0x${string}`,
    oracleAddress: '0x3333333333333333333333333333333333333333',
    usdcAddress: '0x4444444444444444444444444444444444444444',
    escrowAddress: '0x5555555555555555555555555555555555555555',
    simpleSettlerAddress: '0x6666666666666666666666666666666666666666',
    chainId: 8453,
}

// Replicate computeEscrowId manually for ground-truth comparison
function manualEscrowId(params: CreateEscrowParams, salt: `0x${string}`): `0x${string}` {
    const encoded = encodeAbiParameters(
        [
            {
                type: 'tuple',
                components: [
                    { name: 'salt', type: 'bytes12' },
                    { name: 'depositor', type: 'address' },
                    { name: 'recipient', type: 'address' },
                    { name: 'token', type: 'address' },
                    { name: 'escrowAmount', type: 'uint256' },
                    { name: 'refundAmount', type: 'uint256' },
                    { name: 'refundTimestamp', type: 'uint256' },
                    { name: 'settler', type: 'address' },
                    { name: 'sender', type: 'address' },
                    { name: 'settlementId', type: 'bytes32' },
                    { name: 'senderChainId', type: 'uint256' },
                ],
            },
        ],
        [
            {
                salt,
                depositor: params.buyer,
                recipient: params.seller,
                token: params.usdcAddress,
                escrowAmount: params.usdcAmount,
                refundAmount: params.usdcAmount,
                refundTimestamp: params.deadline,
                settler: params.simpleSettlerAddress,
                sender: params.oracleAddress,
                settlementId: params.orderId,
                senderChainId: BigInt(params.chainId),
            },
        ],
    )
    return keccak256(encoded)
}

describe('computeEscrowId', () => {
    it('produces a 32-byte hex string', () => {
        const id = computeEscrowId(BASE_PARAMS)
        expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('matches manual keccak256(abi.encode(struct)) with default salt', () => {
        const defaultSalt = padHex('0x', { size: 12, dir: 'right' })
        const expected = manualEscrowId(BASE_PARAMS, defaultSalt as `0x${string}`)
        expect(computeEscrowId(BASE_PARAMS)).toBe(expected)
    })

    it('matches manual encoding when explicit salt is provided', () => {
        const salt = '0xdeadbeefcafe000000000000' as `0x${string}`
        const params = { ...BASE_PARAMS, salt }
        const expected = manualEscrowId(params, salt)
        expect(computeEscrowId(params)).toBe(expected)
    })

    it('produces different ids for different buyers', () => {
        const id1 = computeEscrowId(BASE_PARAMS)
        const id2 = computeEscrowId({
            ...BASE_PARAMS,
            buyer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })
        expect(id1).not.toBe(id2)
    })

    it('produces different ids for different amounts', () => {
        const id1 = computeEscrowId(BASE_PARAMS)
        const id2 = computeEscrowId({ ...BASE_PARAMS, usdcAmount: 200_000_000n })
        expect(id1).not.toBe(id2)
    })

    it('produces different ids for different orderIds', () => {
        const id1 = computeEscrowId(BASE_PARAMS)
        const id2 = computeEscrowId({
            ...BASE_PARAMS,
            orderId: `0x${'ff'.repeat(32)}` as `0x${string}`,
        })
        expect(id1).not.toBe(id2)
    })

    it('produces different ids for different salts', () => {
        const id1 = computeEscrowId(BASE_PARAMS)
        const id2 = computeEscrowId({
            ...BASE_PARAMS,
            salt: '0x010000000000000000000000' as `0x${string}`,
        })
        expect(id1).not.toBe(id2)
    })

    it('is deterministic — same params produce same id', () => {
        expect(computeEscrowId(BASE_PARAMS)).toBe(computeEscrowId({ ...BASE_PARAMS }))
    })

    it('handles zero address as oracle', () => {
        const id = computeEscrowId({ ...BASE_PARAMS, oracleAddress: zeroAddress })
        expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    })
})
