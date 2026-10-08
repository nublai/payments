import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import type { EscrowStatus } from '@nubl/relayer-client'
import { executeEscrowStatus } from '../src/lib/escrow-status'
import { EscrowError, type ResolveEscrowChainNetworkContractsResult } from '../src/lib/escrow-common'
import type { ChainName, EnvName } from '../src/lib/network-config'
import { installFormerProdDeployments } from './helpers/former-deployment-env'

let restoreFormerProdDeployments = () => {}

beforeAll(() => {
    restoreFormerProdDeployments = installFormerProdDeployments()
})

afterAll(() => {
    restoreFormerProdDeployments()
})

const VALID_ESCROW_ID = `0x${'00'.repeat(32)}` as const

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
    const getEscrowStatus = mock(async (): Promise<EscrowStatus> => ({
        status: 'created',
        escrow: {
            depositor: '0x1111111111111111111111111111111111111111',
            recipient: '0x2222222222222222222222222222222222222222',
            token: '0x4444444444444444444444444444444444444444',
            escrowAmount: 1000000n,
            refundAmount: 0n,
            refundTimestamp: 9999999999n,
            settler: '0x3333333333333333333333333333333333333333',
            sender: '0x3333333333333333333333333333333333333333',
            settlementId: `0x${'02'.repeat(32)}`,
            senderChainId: 8453n,
        },
    }))

    const result = await executeEscrowStatus(
        {
            env: 'prod',
            escrowId: VALID_ESCROW_ID,
            chain: 'base',
        },
        {
            resolveEscrowChainNetworkContracts: mock(
                (_env: EnvName, chain?: ChainName): ResolveEscrowChainNetworkContractsResult => {
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
                },
            ),
            getEscrowStatus,
        },
    )

    expect(result.type).toBe('escrow_status')
    expect(result.escrowId).toBe(VALID_ESCROW_ID)
    expect(result.chain).toBe('base')
    expect(result.status).toBe('created')
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
            resolveEscrowChainNetworkContracts: mock((): ResolveEscrowChainNetworkContractsResult => ({
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
