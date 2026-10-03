import { describe, it, expect } from 'vitest'
import { decodeFunctionData, padHex } from 'viem'
import { escrowAbi } from '@agentic-payments/contracts/abis'
import { createEscrowCalls } from '../../../src/escrow/createEscrowCalls.js'
import type { CreateEscrowParams } from '../../../src/escrow/types.js'

const PARAMS: CreateEscrowParams = {
    buyer: '0x1111111111111111111111111111111111111111',
    seller: '0x2222222222222222222222222222222222222222',
    usdcAmount: 50_000_000n, // 50 USDC
    deadline: 1800000000n,
    orderId: `0x${'ab'.repeat(32)}` as `0x${string}`,
    oracleAddress: '0x3333333333333333333333333333333333333333',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    escrowAddress: '0x5555555555555555555555555555555555555555',
    simpleSettlerAddress: '0x6666666666666666666666666666666666666666',
    chainId: 8453,
}

describe('createEscrowCalls', () => {
    it('returns exactly two calls', () => {
        expect(createEscrowCalls(PARAMS)).toHaveLength(2)
    })

    it('first call targets the USDC token address', () => {
        const [approve] = createEscrowCalls(PARAMS)
        expect(approve.target.toLowerCase()).toBe(PARAMS.usdcAddress.toLowerCase())
        expect(approve.value).toBe(0n)
    })

    it('first call encodes approve(escrowAddress, usdcAmount)', () => {
        const [approve] = createEscrowCalls(PARAMS)
        // selector for approve(address,uint256) = 0x095ea7b3
        expect(approve.data.startsWith('0x095ea7b3')).toBe(true)
        // escrowAddress padded to 32 bytes should appear in calldata
        expect(approve.data.toLowerCase()).toContain(
            PARAMS.escrowAddress.toLowerCase().replace('0x', '').padStart(64, '0'),
        )
    })

    it('second call targets the escrow contract', () => {
        const [, escrow] = createEscrowCalls(PARAMS)
        expect(escrow.target.toLowerCase()).toBe(PARAMS.escrowAddress.toLowerCase())
        expect(escrow.value).toBe(0n)
    })

    it('second call encodes Escrow.escrow([struct]) with correct fields', () => {
        const [, escrowCall] = createEscrowCalls(PARAMS)
        const decoded = decodeFunctionData({ abi: escrowAbi, data: escrowCall.data })
        expect(decoded.functionName).toBe('escrow')

        const [structs] = decoded.args as unknown as [
            readonly {
                depositor: string
                recipient: string
                token: string
                escrowAmount: bigint
                refundAmount: bigint
                refundTimestamp: bigint
                settler: string
                sender: string
                settlementId: `0x${string}`
                senderChainId: bigint
            }[],
        ]
        expect(structs).toHaveLength(1)

        const s = structs[0]
        expect(s.depositor.toLowerCase()).toBe(PARAMS.buyer.toLowerCase())
        expect(s.recipient.toLowerCase()).toBe(PARAMS.seller.toLowerCase())
        expect(s.token.toLowerCase()).toBe(PARAMS.usdcAddress.toLowerCase())
        expect(s.escrowAmount).toBe(PARAMS.usdcAmount)
        expect(s.refundAmount).toBe(PARAMS.usdcAmount)
        expect(s.refundTimestamp).toBe(PARAMS.deadline)
        expect(s.settler.toLowerCase()).toBe(PARAMS.simpleSettlerAddress.toLowerCase())
        expect(s.sender.toLowerCase()).toBe(PARAMS.oracleAddress.toLowerCase())
        expect(s.settlementId.toLowerCase()).toBe(PARAMS.orderId.toLowerCase())
        expect(s.senderChainId).toBe(BigInt(PARAMS.chainId))
    })

    it('uses default zero salt when none provided', () => {
        const [, escrowCall] = createEscrowCalls(PARAMS)
        const decoded = decodeFunctionData({ abi: escrowAbi, data: escrowCall.data })
        const [structs] = decoded.args as unknown as [readonly { salt: `0x${string}` }[]]
        const defaultSalt = padHex('0x', { size: 12, dir: 'right' })
        expect(structs[0].salt.toLowerCase()).toBe(defaultSalt.toLowerCase())
    })

    it('respects explicit salt when provided', () => {
        const salt = '0xdeadbeefcafe000000000000' as `0x${string}`
        const [, escrowCall] = createEscrowCalls({ ...PARAMS, salt })
        const decoded = decodeFunctionData({ abi: escrowAbi, data: escrowCall.data })
        const [structs] = decoded.args as unknown as [readonly { salt: `0x${string}` }[]]
        expect(structs[0].salt.toLowerCase()).toBe(salt.toLowerCase())
    })

    it('approve and escrow calls are consistent — same escrowAddress and amount', () => {
        const [approve, escrowCall] = createEscrowCalls(PARAMS)
        const decoded = decodeFunctionData({ abi: escrowAbi, data: escrowCall.data })
        const [structs] = decoded.args as unknown as [readonly { escrowAmount: bigint }[]]

        expect(approve.target.toLowerCase()).toBe(PARAMS.usdcAddress.toLowerCase())
        expect(structs[0].escrowAmount).toBe(PARAMS.usdcAmount)
    })
})
