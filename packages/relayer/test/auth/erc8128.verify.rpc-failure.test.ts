import { beforeEach, describe, expect, it, vi } from 'vitest'

import { verifyErc8128Request, type Erc8128Config } from '../../src/auth/erc8128/verify'
import { stubErc8128ChainClient } from '../helpers/fakes'

const ADDRESS = '0x1111111111111111111111111111111111111111'

const mocks = {
    getCode: vi.fn(),
    verifyMessage: vi.fn(),
}

const driveVerifyRequest: NonNullable<Erc8128Config['verifyRequest']> = async (
    _request,
    verifyMessage,
) => {
    const ok = await verifyMessage({
        address: ADDRESS,
        message: { raw: '0x010203' },
        signature: '0xdeadbeef',
    })

    if (ok) {
        throw new Error('driveVerifyRequest expected chain verification to fail')
    }

    return {
        ok: false,
        reason: 'bad_signature',
        detail: 'bad sig',
    }
}

describe('verifyErc8128Request rpc fallback handling', () => {
    beforeEach(() => {
        mocks.getCode.mockReset()
        mocks.verifyMessage.mockReset()

        mocks.getCode.mockResolvedValue('0x1234')
        mocks.verifyMessage.mockRejectedValue(new Error('rpc timeout'))
    })

    it('returns auth failure when chain verification calls reject', async () => {
        const result = await verifyErc8128Request(
            {
                env: { CHAIN_IDS: '8453' },
                request: new Request('https://relayer.example.com/', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'signature-input': `sig1=();keyid="erc8128:8453:${ADDRESS}"`,
                    },
                    body: '{"jsonrpc":"2.0","id":1,"method":"wallet_sendPreparedCalls","params":[]}',
                }),
                nowSeconds: 1_700_000_000,
            },
            {
                maxValiditySeconds: 120,
                clockSkewSeconds: 30,
                requireRequestBound: true,
                requireNonReplayable: true,
                nonceStore: {
                    consumeNonce: vi.fn(async () => true),
                },
                getChainClient: () =>
                    stubErc8128ChainClient({
                        getCode: mocks.getCode,
                        verifyMessage: mocks.verifyMessage,
                    }),
                verifyRequest: driveVerifyRequest,
            },
        )

        expect(result).toEqual(
            expect.objectContaining({
                ok: false,
                code: 'BAD_SIGNATURE',
            }),
        )
        expect(mocks.verifyMessage).toHaveBeenCalledTimes(2)
    })
})
