import { padHex } from 'viem'
import type { CreateEscrowParams } from './types.js'

/**
 * ABI for encoding the Escrow struct.
 * Matches IEscrow.Escrow field order exactly.
 */
export const ESCROW_STRUCT_ABI = [
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
] as const

export interface EscrowStruct {
    salt: `0x${string}`
    depositor: `0x${string}`
    recipient: `0x${string}`
    token: `0x${string}`
    escrowAmount: bigint
    refundAmount: bigint
    refundTimestamp: bigint
    settler: `0x${string}`
    sender: `0x${string}`
    settlementId: `0x${string}`
    senderChainId: bigint
}

/**
 * Builds the Escrow struct from CreateEscrowParams.
 * Single source of truth for mapping params -> Solidity struct fields.
 */
export function buildEscrowStruct(params: CreateEscrowParams): EscrowStruct {
    const salt = params.salt ?? padHex('0x', { size: 12, dir: 'right' })

    return {
        salt: salt as `0x${string}`,
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
    }
}
