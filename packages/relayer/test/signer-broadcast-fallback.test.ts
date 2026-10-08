import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { SignedAuthorization } from 'viem'

import {
    SignerDO,
    buildRawFallbackBroadcastRequest,
    isFillTransactionUnsupportedError,
} from '../src/durable-objects/signer.do'

type SignAndBroadcastHost<EnsureClients> = {
    ensureClients: EnsureClients
    signAndBroadcastPrepared: (
        this: { ensureClients: EnsureClients },
        txParams: {
            to: string
            data: `0x${string}`
            value: bigint
            authorizationList?: SignedAuthorization[]
        },
        nonce: number,
        chainId: number,
        feeParams: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    ) => Promise<`0x${string}`>
}

describe('signer broadcast fallback helpers', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe('isFillTransactionUnsupportedError', () => {
        it('matches explicit unsupported method errors', () => {
            expect(
                isFillTransactionUnsupportedError(
                    'eth_fillTransaction is not available on the MATIC_MAINNET',
                ),
            ).toBe(true)
            expect(
                isFillTransactionUnsupportedError(
                    'the method eth_fillTransaction does not exist/is not available',
                ),
            ).toBe(true)
            expect(isFillTransactionUnsupportedError('Method not found: eth_fillTransaction')).toBe(
                true,
            )
        })

        it('ignores unrelated broadcast errors', () => {
            expect(isFillTransactionUnsupportedError('nonce too low')).toBe(false)
            expect(isFillTransactionUnsupportedError('replacement transaction underpriced')).toBe(
                false,
            )
            expect(isFillTransactionUnsupportedError('method not found')).toBe(false)
        })
    })

    describe('buildRawFallbackBroadcastRequest', () => {
        it('preserves eip-7702 authorization list and explicit tx fields', () => {
            const account = privateKeyToAccount(
                '0x59c6995e998f97a5a0044966f0945383f8dcf63d8d8f3d6cce5f83b65e93a8f6',
            )

            const authorizationList: SignedAuthorization[] = [
                {
                    chainId: 137,
                    address: '0xF42350E2c880fb325E9a42aa8695EBc354DEC5E8',
                    nonce: 518,
                    yParity: 1,
                    r: '0xaf52f818edc5a886c2588404097bdd1aaf4dca48de8025fcce1f98dde6e65175',
                    s: '0x1a27128da6bc135d362456d9911c308d9320c16bdef641094a2a74f65146c519',
                },
            ]

            const request = buildRawFallbackBroadcastRequest({
                txParams: {
                    to: '0x000000000000000000000000000000000000051F',
                    data: '0x',
                    value: 0n,
                    authorizationList,
                },
                nonce: 2394,
                chainId: 137,
                account,
                gas: 21000n,
                feeParams: {
                    maxFeePerGas: 123n,
                    maxPriorityFeePerGas: 45n,
                },
            })

            expect(request.authorizationList).toEqual(authorizationList)
            expect(request.nonce).toBe(2394)
            expect(request.chain.id).toBe(137)
            expect(request.gas).toBe(21000n)
            expect(request.maxFeePerGas).toBe(123n)
            expect(request.maxPriorityFeePerGas).toBe(45n)
            expect(request.account.address).toBe(account.address)
        })
    })

    describe('signAndBroadcastPrepared orchestration', () => {
        it('falls back to raw send when primary path fails with eth_fillTransaction unsupported', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => undefined)
            vi.spyOn(console, 'info').mockImplementation(() => undefined)

            const account = privateKeyToAccount(
                '0x59c6995e998f97a5a0044966f0945383f8dcf63d8d8f3d6cce5f83b65e93a8f6',
            )

            const sendTransaction = vi
                .fn()
                .mockRejectedValue(
                    new Error('eth_fillTransaction is not available on the MATIC_MAINNET'),
                )

            const estimateGas = vi.fn().mockResolvedValue(21000n)
            const signTransaction = vi.fn().mockResolvedValue('0xdeadbeef')
            const sendRawTransaction = vi.fn().mockResolvedValue('0xabc123')

            const ensureClients = vi.fn().mockReturnValue({
                publicClient: { estimateGas, sendRawTransaction },
                walletClient: { sendTransaction, signTransaction },
                account,
            })

            const signer = Object.create(SignerDO.prototype) as SignAndBroadcastHost<
                typeof ensureClients
            >

            signer.ensureClients = ensureClients

            const signAndBroadcastPrepared = signer.signAndBroadcastPrepared as (
                this: { ensureClients: typeof ensureClients },
                txParams: {
                    to: string
                    data: `0x${string}`
                    value: bigint
                    authorizationList?: SignedAuthorization[]
                },
                nonce: number,
                chainId: number,
                feeParams: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
            ) => Promise<`0x${string}`>

            const txHash = await signAndBroadcastPrepared.call(
                signer,
                {
                    to: '0x000000000000000000000000000000000000051F',
                    data: '0x',
                    value: 0n,
                },
                2394,
                137,
                { maxFeePerGas: 123n, maxPriorityFeePerGas: 45n },
            )

            expect(txHash).toBe('0xabc123')
            expect(sendTransaction).toHaveBeenCalledTimes(1)
            expect(estimateGas).toHaveBeenCalledTimes(1)
            expect(signTransaction).toHaveBeenCalledTimes(1)
            expect(sendRawTransaction).toHaveBeenCalledWith({
                serializedTransaction: '0xdeadbeef',
            })
        })

        it('does not fallback on unrelated primary broadcast errors', async () => {
            const account = privateKeyToAccount(
                '0x59c6995e998f97a5a0044966f0945383f8dcf63d8d8f3d6cce5f83b65e93a8f6',
            )

            const sendTransaction = vi.fn().mockRejectedValue(new Error('nonce too low'))
            const estimateGas = vi.fn()
            const signTransaction = vi.fn()
            const sendRawTransaction = vi.fn()

            const ensureClients = vi.fn().mockReturnValue({
                publicClient: { estimateGas, sendRawTransaction },
                walletClient: { sendTransaction, signTransaction },
                account,
            })

            const signer = Object.create(SignerDO.prototype) as SignAndBroadcastHost<
                typeof ensureClients
            >

            signer.ensureClients = ensureClients

            const signAndBroadcastPrepared = signer.signAndBroadcastPrepared as (
                this: { ensureClients: typeof ensureClients },
                txParams: { to: string; data: `0x${string}`; value: bigint },
                nonce: number,
                chainId: number,
                feeParams: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
            ) => Promise<`0x${string}`>

            await expect(
                signAndBroadcastPrepared.call(
                    signer,
                    {
                        to: '0x000000000000000000000000000000000000051F',
                        data: '0x',
                        value: 0n,
                    },
                    2394,
                    137,
                    { maxFeePerGas: 123n, maxPriorityFeePerGas: 45n },
                ),
            ).rejects.toThrow('Failed to broadcast transaction: nonce too low')

            expect(estimateGas).not.toHaveBeenCalled()
            expect(signTransaction).not.toHaveBeenCalled()
            expect(sendRawTransaction).not.toHaveBeenCalled()
        })
    })
})
