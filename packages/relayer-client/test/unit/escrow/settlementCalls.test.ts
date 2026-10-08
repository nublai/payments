import { describe, it, expect } from 'vitest'
import { decodeFunctionData, type Hex } from 'viem'
import { escrowAbi, simpleSettlerAbi } from '@nubl/contracts/abis'
import { writeSettlementCalls } from '../../../src/escrow/writeSettlementCalls.js'
import { refundEscrowCalls } from '../../../src/escrow/refundEscrowCalls.js'
import { repeatedHex } from '../../helpers/hex'

const ESCROW_ID = repeatedHex('11', 32)

const SETTLEMENT_ID = repeatedHex('22', 32)

const ORACLE = '0x3333333333333333333333333333333333333333'

const SIMPLE_SETTLER = '0x4444444444444444444444444444444444444444'

const ESCROW_ADDR = '0x5555555555555555555555555555555555555555'

const SIGNATURE = repeatedHex('aa', 65)

const CHAIN_ID = 8453

function settlerWriteArgs(data: Hex) {
    const decoded = decodeFunctionData({ abi: simpleSettlerAbi, data })

    if (decoded.functionName !== 'write') {
        throw new Error(`expected write, got ${decoded.functionName}`)
    }

    return decoded.args
}

function escrowIds(data: Hex, functionName: 'settle' | 'refund') {
    const decoded = decodeFunctionData({ abi: escrowAbi, data })

    if (decoded.functionName !== functionName) {
        throw new Error(`expected ${functionName}, got ${decoded.functionName}`)
    }

    return decoded.args[0]
}

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

        const [sender, settlementId, chainId] = settlerWriteArgs(calls[0].data)

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
        const ids = escrowIds(calls[1].data, 'settle')
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
        const ids = escrowIds(calls[0].data, 'refund')
        expect(ids[0].toLowerCase()).toBe(ESCROW_ID.toLowerCase())
    })
})
