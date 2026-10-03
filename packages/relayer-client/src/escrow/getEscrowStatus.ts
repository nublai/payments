import type { PublicClient, Address, Hex } from 'viem'
import { escrowAbi } from '@agentic-payments/contracts/abis'
import type { EscrowStatus } from './types.js'

const STATUS_MAP: Record<number, EscrowStatus['status']> = {
    0: 'null',
    1: 'created',
    2: 'refund_deposit',
    3: 'refund_recipient',
    4: 'finalized',
}

export async function getEscrowStatus(params: {
    escrowId: Hex
    escrowAddress: Address
    publicClient: PublicClient
}): Promise<EscrowStatus> {
    const { escrowId, escrowAddress, publicClient } = params

    const [rawStatus, escrow] = await Promise.all([
        publicClient.readContract({
            address: escrowAddress,
            abi: escrowAbi,
            functionName: 'statuses',
            args: [escrowId],
        }),
        publicClient.readContract({
            address: escrowAddress,
            abi: escrowAbi,
            functionName: 'escrows',
            args: [escrowId],
        }),
    ])

    const status = STATUS_MAP[Number(rawStatus)] ?? 'null'

    if (status === 'null') {
        return { status, escrow: null }
    }

    // escrows() returns a named tuple — TypeScript readonly named tuples
    // require index access, not property access
    const [
        ,
        depositor,
        recipient,
        token,
        escrowAmount,
        refundAmount,
        refundTimestamp,
        settler,
        sender,
        settlementId,
        senderChainId,
    ] = escrow

    return {
        status,
        escrow: {
            depositor,
            recipient,
            token,
            escrowAmount,
            refundAmount,
            refundTimestamp,
            settler,
            sender,
            settlementId: settlementId as Hex,
            senderChainId,
        },
    }
}
