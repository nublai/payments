import { describe, it, expect } from 'vitest'
import { decodeFunctionData } from 'viem'
import { escrowAbi, simpleSettlerAbi } from '@agentic-payments/contracts/abis'
import { writeSettlementCalls } from '../../../src/escrow/writeSettlementCalls.js'
import { refundEscrowCalls } from '../../../src/escrow/refundEscrowCalls.js'

const ESCROW_ID = `0x${'11'.repeat(32)}` as `0x${string}`
const SETTLEMENT_ID = `0x${'22'.repeat(32)}` as `0x${string}`
const ORACLE = '0x3333333333333333333333333333333333333333' as `0x${string}`
const SIMPLE_SETTLER = '0x4444444444444444444444444444444444444444' as `0x${string}`
const ESCROW_ADDR = '0x5555555555555555555555555555555555555555' as `0x${string}`
const SIGNATURE = `0x${'aa'.repeat(65)}` as `0x${string}`
const CHAIN_ID = 8453

describe('writeSettlementCalls', () => {
    const calls = writeSettlementCalls({
        escrowId: ESCROW_ID,
        settlementId: SETTLEMENT_ID,
        oracleAddress: ORACLE,
        chainId: CHAIN_ID,
        signature: SIGNATURE,
        simpleSettlerAddress: SIMPLE_SETTLER,
        escrowAddress: ESCROW_ADDR,
    })

    it('returns exactly two calls', () => {
        expect(calls).toHaveLength(2)
    })

    it('first call targets SimpleSettler', () => {
        expect(calls[0].target.toLowerCase()).toBe(SIMPLE_SETTLER.toLowerCase())
        expect(calls[0].value).toBe(0n)
    })

    it('first call encodes SimpleSettler.write() with correct args', () => {
        const decoded = decodeFunctionData({ abi: simpleSettlerAbi, data: calls[0].data })
        expect(decoded.functionName).toBe('write')
        const [sender, settlementId, chainId] = decoded.args as [
            `0x${string}`,
            `0x${string}`,
            bigint,
            `0x${string}`,
        ]
        expect(sender.toLowerCase()).toBe(ORACLE.toLowerCase())
        expect(settlementId.toLowerCase()).toBe(SETTLEMENT_ID.toLowerCase())
        expect(chainId).toBe(BigInt(CHAIN_ID))
    })

    it('second call targets Escrow', () => {
        expect(calls[1].target.toLowerCase()).toBe(ESCROW_ADDR.toLowerCase())
        expect(calls[1].value).toBe(0n)
    })

    it('second call encodes Escrow.settle() with correct escrowId', () => {
        const decoded = decodeFunctionData({ abi: escrowAbi, data: calls[1].data })
        expect(decoded.functionName).toBe('settle')
        const [ids] = decoded.args as [readonly `0x${string}`[]]
        expect(ids[0].toLowerCase()).toBe(ESCROW_ID.toLowerCase())
    })
})

describe('refundEscrowCalls', () => {
    const calls = refundEscrowCalls({ escrowId: ESCROW_ID, escrowAddress: ESCROW_ADDR })

    it('returns exactly one call', () => {
        expect(calls).toHaveLength(1)
    })

    it('targets the Escrow contract', () => {
        expect(calls[0].target.toLowerCase()).toBe(ESCROW_ADDR.toLowerCase())
        expect(calls[0].value).toBe(0n)
    })

    it('encodes Escrow.refund() with correct escrowId', () => {
        const decoded = decodeFunctionData({ abi: escrowAbi, data: calls[0].data })
        expect(decoded.functionName).toBe('refund')
        const [ids] = decoded.args as [readonly `0x${string}`[]]
        expect(ids[0].toLowerCase()).toBe(ESCROW_ID.toLowerCase())
    })
})
