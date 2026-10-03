import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/types/env'

const verifyMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/auth/erc8128/verify', () => ({
    verifyErc8128Request: verifyMock,
}))

import { createErc8128Provider } from '../../src/auth/providers/erc8128'

describe('erc8128 auth provider', () => {
    const env = {
        ERC8128_ENABLED: 'true',
        CHAIN_IDS: '8453',
        HTTP_AUTH_NONCE_MANAGER: {
            idFromName: vi.fn(),
            get: vi.fn(),
        },
    } as unknown as Env

    it('is enabled only when ERC8128_ENABLED=true', () => {
        const provider = createErc8128Provider()
        expect(provider.enabled({ ERC8128_ENABLED: 'true' } as Env)).toBe(true)
        expect(provider.enabled({ ERC8128_ENABLED: 'false' } as Env)).toBe(false)
    })

    it('returns success when ERC-8128 verification succeeds', async () => {
        verifyMock.mockResolvedValueOnce({
            ok: true,
            keyId: {
                raw: 'erc8128:8453:0x1111111111111111111111111111111111111111',
                namespace: 'erc8128',
                chainId: 8453,
                address: '0x1111111111111111111111111111111111111111',
            },
            signerType: 'EOA',
            nonceKey: 'k',
        })

        const provider = createErc8128Provider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', { method: 'POST', body: '{}' }),
            { env, nowSeconds: 1_700_000_000 },
        )

        expect(result).toEqual({ ok: true })
    })

    it('returns mapped failure when ERC-8128 verification fails', async () => {
        verifyMock.mockResolvedValueOnce({
            ok: false,
            code: 'REPLAYED_NONCE',
            message: 'replayed',
        })

        const provider = createErc8128Provider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', { method: 'POST', body: '{}' }),
            { env, nowSeconds: 1_700_000_000 },
        )

        expect(result).toEqual({
            ok: false,
            code: 'REPLAYED_NONCE',
            message: 'replayed',
        })
    })

    it('returns BAD_SIGNATURE when verifier throws', async () => {
        verifyMock.mockRejectedValueOnce(new Error('rpc down'))

        const provider = createErc8128Provider()
        const result = await provider.verify(
            new Request('https://relayer.example.com/', { method: 'POST', body: '{}' }),
            { env, nowSeconds: 1_700_000_000 },
        )

        expect(result).toEqual({
            ok: false,
            code: 'BAD_SIGNATURE',
            message: 'erc8128 failed',
        })
    })
})
