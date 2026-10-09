import { expect, mock, test } from 'bun:test'
import type { Address } from 'viem'
import { readAccountNonce } from '../src/lib/relayer-client-utils'
import { nonceAbi } from '../src/lib/nonce-utils'

test('readAccountNonce uses shared nonce ABI and seqKey 0', async () => {
    const readContract = mock(
        async (_args: {
            address: Address
            abi: typeof nonceAbi
            functionName: 'getNonce'
            args: [bigint]
        }) => 9n,
    )

    const nonce = await readAccountNonce(
        {
            readContract,
        },
        '0x1111111111111111111111111111111111111111',
    )

    expect(nonce).toBe(9n)
    expect(readContract).toHaveBeenCalledTimes(1)
    const call = readContract.mock.calls[0]

    if (!call?.[0]) {
        throw new Error('Expected readContract to be called once')
    }

    const args = call[0]
    expect(args.address).toBe('0x1111111111111111111111111111111111111111')
    expect(args.functionName).toBe('getNonce')
    expect(args.args).toEqual([0n])
})
