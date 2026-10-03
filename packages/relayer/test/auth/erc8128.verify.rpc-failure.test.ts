import { beforeEach, describe, expect, it, vi } from 'vitest'

const ADDRESS = '0x1111111111111111111111111111111111111111'

const mocks = vi.hoisted(() => ({
    getCode: vi.fn(),
    verifyMessage: vi.fn(),
}))

vi.mock('@slicekit/erc8128', () => ({
    parseKeyId: (raw: string) => {
        const [, chainId, address] = raw.split(':')
        return { chainId: Number.parseInt(chainId, 10), address }
    },
    verifyRequest: async (
        _request: Request,
        verifyMessage: (args: unknown) => Promise<boolean>,
    ) => {
        const ok = await verifyMessage({
            address: ADDRESS,
            message: { raw: '0x010203' },
            signature: '0xdeadbeef',
        })

        if (ok) {
            return {
                ok: true as const,
                params: {
                    keyid: `erc8128:8453:${ADDRESS}`,
                    nonce: 'nonce-1',
                },
            }
        }

        return {
            ok: false as const,
            reason: 'bad_signature' as const,
            detail: 'bad sig',
        }
    },
}))

vi.mock('../../src/lib/multi-chain-client', () => ({
    getChainClient: vi.fn(() => ({
        getCode: mocks.getCode,
        verifyMessage: mocks.verifyMessage,
    })),
}))

import { verifyErc8128Request } from '../../src/auth/erc8128/verify'

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
