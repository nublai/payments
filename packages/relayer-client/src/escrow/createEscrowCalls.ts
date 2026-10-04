import { encodeFunctionData, parseAbi } from 'viem'
import { escrowAbi } from '@nubl/contracts/abis'
import type { Call } from '../types.js'
import type { CreateEscrowParams } from './types.js'
import { buildEscrowStruct } from './buildEscrowStruct.js'

const ERC20_APPROVE_ABI = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)',
])

/**
 * Builds the two on-chain calls needed to create an escrow:
 *   [0] USDC.approve(escrow, amount)
 *   [1] Escrow.escrow([struct])
 *
 * Pass the returned Call[] directly to prepareCalls({ calls }).
 * The buyer's Account executes both atomically via the Orchestrator.
 */
export function createEscrowCalls(params: CreateEscrowParams): Call[] {
    const escrowStruct = buildEscrowStruct(params)

    const approveCall: Call = {
        target: params.usdcAddress,
        value: 0n,
        data: encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: 'approve',
            args: [params.escrowAddress, params.usdcAmount],
        }),
    }

    const escrowCall: Call = {
        target: params.escrowAddress,
        value: 0n,
        data: encodeFunctionData({
            abi: escrowAbi,
            functionName: 'escrow',
            args: [[escrowStruct]],
        }),
    }

    return [approveCall, escrowCall]
}
