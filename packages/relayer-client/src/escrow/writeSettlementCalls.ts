import { encodeFunctionData } from 'viem'
import type { Address, Hex } from 'viem'
import { escrowAbi, simpleSettlerAbi } from '@agentic-payments/contracts/abis'
import type { Call } from '../types.js'

/**
 * Builds the two on-chain calls needed to settle an escrow:
 *   [0] SimpleSettler.write(oracle, settlementId, chainId, signature)
 *   [1] Escrow.settle([escrowId])
 *
 * Pass the returned Call[] directly to prepareCalls({ calls }).
 * The oracle bot's Account executes both atomically via the Orchestrator.
 */
export function writeSettlementCalls(params: {
    escrowId: Hex
    settlementId: Hex
    oracleAddress: Address
    chainId: number
    signature: Hex
    simpleSettlerAddress: Address
    escrowAddress: Address
}): Call[] {
    const {
        escrowId,
        settlementId,
        oracleAddress,
        chainId,
        signature,
        simpleSettlerAddress,
        escrowAddress,
    } = params

    return [
        {
            target: simpleSettlerAddress,
            value: 0n,
            data: encodeFunctionData({
                abi: simpleSettlerAbi,
                functionName: 'write',
                args: [oracleAddress, settlementId, BigInt(chainId), signature],
            }),
        },
        {
            target: escrowAddress,
            value: 0n,
            data: encodeFunctionData({
                abi: escrowAbi,
                functionName: 'settle',
                args: [[escrowId]],
            }),
        },
    ]
}
