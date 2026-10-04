import { encodeFunctionData } from 'viem'
import type { Address, Hex } from 'viem'
import { escrowAbi } from '@nubl/contracts/abis'
import type { Call } from '../types.js'

/**
 * Builds the call to trigger a permissionless refund after the escrow's
 * refundTimestamp has passed. Both depositor and recipient receive their portions.
 *
 * Pass the returned Call[] directly to prepareCalls({ calls }).
 * Can be submitted by the oracle bot or the buyer's own Account.
 */
export function refundEscrowCalls(params: { escrowId: Hex; escrowAddress: Address }): Call[] {
    const { escrowId, escrowAddress } = params

    return [
        {
            target: escrowAddress,
            value: 0n,
            data: encodeFunctionData({
                abi: escrowAbi,
                functionName: 'refund',
                args: [[escrowId]],
            }),
        },
    ]
}
