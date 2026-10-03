import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { BearerTokenSchema, WalletSessionTokenSchema } from '@towns-labs/proto'
import { bin_fromHexString } from '@towns-labs/utils'
import { makeWalletSessionToken } from '../../signerContext'

describe('makeWalletSessionToken', () => {
    it('builds a WalletSessionToken payload with expected fields', () => {
        const bearerToken = create(BearerTokenSchema, {
            delegatePrivateKey:
                '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            delegateSig: new Uint8Array([1, 2, 3, 4]),
            expiryEpochMs: 1_700_000_000_000n,
        })
        const bearerTokenHex = `0x${Buffer.from(toBinary(BearerTokenSchema, bearerToken)).toString('hex')}`

        const tokenHex = makeWalletSessionToken({
            sessionPrivateKey: '0x59c6995e998f97a5a0044966f0945388cf6f64f6b5f8a6d4f7e7a3fa8f8ff7f0',
            accountAddress: '0x1111111111111111111111111111111111111111',
            chainId: 8453,
            expiryEpochMs: 1_800_000_000_000,
            bearerToken: bearerTokenHex,
            delegateSig: new Uint8Array([9, 8, 7, 6]),
            delegateExpiryEpochMs: 1_800_000_000_000,
        })

        const decoded = fromBinary(WalletSessionTokenSchema, bin_fromHexString(tokenHex))
        expect(decoded.chainId).toBe(8453n)
        expect(decoded.expiryEpochMs).toBe(1_800_000_000_000n)
        expect(decoded.delegateExpiryEpochMs).toBe(1_800_000_000_000n)
        expect(decoded.sessionPrivateKey).toHaveLength(32)
        expect(decoded.accountAddress).toHaveLength(20)
        expect(Array.from(decoded.delegateSig)).toEqual([9, 8, 7, 6])
        expect(decoded.bearerToken?.delegatePrivateKey).toBe(bearerToken.delegatePrivateKey)
    })

    it('throws on malformed hex inputs', () => {
        expect(() =>
            makeWalletSessionToken({
                sessionPrivateKey: '0x123',
                accountAddress: '0x1111111111111111111111111111111111111111',
                chainId: 8453,
                expiryEpochMs: 1_800_000_000_000,
                bearerToken: '0x0',
                delegateSig: new Uint8Array([1]),
                delegateExpiryEpochMs: 1_800_000_000_000,
            }),
        ).toThrow('Invalid hex value')
    })
})
