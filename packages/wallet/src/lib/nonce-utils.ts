import type { Address } from 'viem'

export const nonceAbi = [
    {
        type: 'function',
        name: 'getNonce',
        stateMutability: 'view',
        inputs: [{ name: 'seqKey', type: 'uint192' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
] as const

export async function readAccountNonce(
    client: {
        readContract: (args: {
            address: Address
            abi: typeof nonceAbi
            functionName: 'getNonce'
            args: [bigint]
        }) => Promise<bigint>
    },
    address: Address,
    seqKey = 0n,
): Promise<bigint> {
    return client.readContract({
        address,
        abi: nonceAbi,
        functionName: 'getNonce',
        args: [seqKey],
    })
}
