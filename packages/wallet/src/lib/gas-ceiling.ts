import { createPublicClient, http, type Address, type Hex } from 'viem'
import { getChain } from '@nubl/relayer-client'

type CallLike = { target: Address; value: bigint; data?: Hex }

/** Per-call execution allowance when the wallet RPC cannot estimate. */
const FALLBACK_EXECUTION_GAS = 150_000n
const HEADROOM = 8n
const FIXED_OVERHEAD = 500_000n

/**
 * Ceiling computed from the calls themselves. Independent of the relayer typed data.
 * Calldata cost plus a fixed execution allowance, with headroom for orchestrator simulation.
 */
export function localCombinedGasCeiling(calls: readonly CallLike[]): bigint {
    let sum = 0n
    for (const call of calls) {
        const bytes = call.data && call.data.length > 2 ? BigInt((call.data.length - 2) / 2) : 0n
        sum += 21_000n + 16n * bytes + FALLBACK_EXECUTION_GAS
    }
    if (sum === 0n) sum = FALLBACK_EXECUTION_GAS
    return sum * HEADROOM + FIXED_OVERHEAD
}

/**
 * Raise the local ceiling with eth_estimateGas from the wallet RPC when it answers.
 * A failed estimate leaves the local ceiling in place.
 */
export async function estimateCombinedGasCeiling(input: {
    rpcUrl: string
    chainId: number
    from: Address
    calls: readonly CallLike[]
}): Promise<bigint> {
    const local = localCombinedGasCeiling(input.calls)
    try {
        const client = createPublicClient({
            chain: getChain(input.chainId, input.rpcUrl),
            transport: http(input.rpcUrl, { timeout: 800 }),
        })
        let estimated = 0n
        for (const call of input.calls) {
            const gas = await client.estimateGas({
                account: input.from,
                to: call.target,
                data: call.data ?? '0x',
                value: call.value,
            })
            estimated += gas
        }
        const fromRpc = estimated * HEADROOM + FIXED_OVERHEAD
        return fromRpc > local ? fromRpc : local
    } catch {
        return local
    }
}
