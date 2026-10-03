import { expect, mock, test } from 'bun:test'
import { executeEscrowStatus } from '../src/lib/escrow-status'
import { EscrowError } from '../src/lib/escrow-common'

const VALID_ESCROW_ID = '0x' + '00'.repeat(32)

test('executeEscrowStatus rejects invalid escrowId with INVALID_ARGUMENT', async () => {
    await expect(
        executeEscrowStatus({
            env: 'prod',
            escrowId: 'not-hex',
        }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    await expect(
        executeEscrowStatus({
            env: 'prod',
            escrowId: '0xab',
        }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    await expect(
        executeEscrowStatus({
            env: 'prod',
            escrowId: '0x' + 'ab'.repeat(31) + 'a',
        }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

test('executeEscrowStatus returns status shape with mocked getEscrowStatus', async () => {
    const getEscrowStatus = mock(async () => ({
        status: 'active' as const,
        escrow: {
            buyer: '0x1111111111111111111111111111111111111111',
            seller: '0x2222222222222222222222222222222222222222',
            oracle: '0x3333333333333333333333333333333333333333',
            amount: 1000000n,
            deadline: 9999999999n,
            orderId: '0x' + '01'.repeat(32),
            settlementId: '0x' + '02'.repeat(32),
        },
    }))

    const result = await executeEscrowStatus(
        {
            env: 'prod',
            escrowId: VALID_ESCROW_ID,
            chain: 'base',
        },
        {
            resolveEscrowChainNetworkContracts: mock((env, chain) => {
                const chainName = chain ?? 'base'
                return {
                    chain: chainName,
                    network: {
                        chainId: 8453,
                        rpcUrl: 'https://mainnet.base.org',
                        relayerUrl: 'https://relayer.example.com',
                        env: 'prod',
                    },
                    contracts: {
                        escrowAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                        simpleSettlerAddress: '0xssssssssssssssssssssssssssssssssssssssss',
                        usdcAddress: '0xuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
                    },
                }
            }),
            getEscrowStatus,
        },
    )

    expect(result.type).toBe('escrow_status')
    expect(result.escrowId).toBe(VALID_ESCROW_ID)
    expect(result.chain).toBe('base')
    expect(result.status).toBe('active')
    expect(result.escrow).toBeDefined()
    expect(result.escrowAddress).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    expect(getEscrowStatus).toHaveBeenCalledTimes(1)
})

test('executeEscrowStatus maps getEscrowStatus errors via toEscrowError', async () => {
    const result = await executeEscrowStatus(
        {
            env: 'prod',
            escrowId: VALID_ESCROW_ID,
        },
        {
            resolveEscrowChainNetworkContracts: mock(() => ({
                chain: 'base',
                network: {
                    chainId: 8453,
                    rpcUrl: 'https://mainnet.base.org',
                    relayerUrl: 'https://relayer.example.com',
                    env: 'prod',
                },
                contracts: {
                    escrowAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                    simpleSettlerAddress: '0xssssssssssssssssssssssssssssssssssssssss',
                    usdcAddress: '0xuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
                },
            })),
            getEscrowStatus: mock(async () => {
                throw new Error('ENOENT: no such file')
            }),
        },
    ).then(
        () => null,
        (err) => err,
    )

    expect(result).toBeInstanceOf(EscrowError)
    expect((result as EscrowError).code).toBe('KEYSTORE_NOT_FOUND')
})
