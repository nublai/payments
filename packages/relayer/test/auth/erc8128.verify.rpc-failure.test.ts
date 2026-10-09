import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signRequest, type EthHttpSigner } from '@slicekit/erc8128'

import { verifyErc8128Request, type NonceStore } from '../../src/auth/erc8128/verify'
import { mockedErc8128ChainClient } from '../helpers/fakes'

const ADDRESS = '0x1111111111111111111111111111111111111111'

const { client, mockGetCode, mockVerifyMessage } = mockedErc8128ChainClient()

const otherAccount = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945382db9f6c0b4b7f3adf8f13e9f5b5b6c5a5',
)

function mismatchedSigner(chainId: number): EthHttpSigner {
    return {
        chainId,
        address: ADDRESS,
        signMessage: async (message) =>
            otherAccount.signMessage({ message: { raw: bytesToHex(message) } }),
    }
}

async function signedRequest(): Promise<Request> {
    const created = 1_700_000_000 - 5

    return signRequest(
        new Request('https://relayer.example.com/', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"jsonrpc":"2.0","id":1,"method":"wallet_sendPreparedCalls","params":[]}',
        }),
        mismatchedSigner(8453),
        {
            label: 'eth',
            binding: 'request-bound',
            replay: 'non-replayable',
            created,
            expires: created + 60,
            nonce: 'nonce-1',
            contentDigest: 'auto',
        },
    )
}

describe('verifyErc8128Request rpc fallback handling', () => {
    beforeEach(() => {
        mockGetCode.mockReset()
        mockVerifyMessage.mockReset()

        mockGetCode.mockResolvedValue('0x1234')
        mockVerifyMessage.mockRejectedValue(new Error('rpc timeout'))
    })

    it('returns auth failure when chain verification calls reject', async () => {
        const result = await verifyErc8128Request(
            {
                env: { CHAIN_IDS: '8453' },
                request: await signedRequest(),
                nowSeconds: 1_700_000_000,
            },
            {
                maxValiditySeconds: 120,
                clockSkewSeconds: 30,
                requireRequestBound: true,
                requireNonReplayable: true,
                nonceStore: {
                    consumeNonce: vi.fn<NonceStore['consumeNonce']>().mockResolvedValue(true),
                },
                getChainClient: () => client,
            },
        )

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'BAD_SIGNATURE',
            }),
        )
        expect(mockVerifyMessage).toHaveBeenCalledTimes(2)
    })
})
