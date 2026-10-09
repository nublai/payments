import { describe, expect, it, vi } from 'vitest'

import { createHttpAuthNonceStore } from '../../src/auth/erc8128/nonce-store'
import { httpAuthNonceNamespace, testEnv } from '../helpers/env'

describe('createHttpAuthNonceStore', () => {
    it('calls nonce DO consumeNonce over rpc with ttlSeconds', async () => {
        const consumeNonce = vi.fn(
            async (_replayKey: string, _ttlSeconds: number): Promise<true> => true,
        )

        const get = vi.fn(() => ({ consumeNonce }))
        const idFromName = vi.fn(() => 'nonce-do-id')

        const env = testEnv({
            HTTP_AUTH_NONCE_MANAGER: httpAuthNonceNamespace({
                idFromName,
                get,
            }),
        })

        const store = createHttpAuthNonceStore(env)
        const accepted = await store.consumeNonce('k:n', 120)

        expect(accepted).toBe(true)
        expect(idFromName).toHaveBeenCalledWith('http-auth-nonces')
        expect(consumeNonce).toHaveBeenCalledTimes(1)
        expect(consumeNonce).toHaveBeenCalledWith('k:n', 120)
    })

    it('returns false when nonce DO rpc call throws', async () => {
        const consumeNonce = vi.fn(async (): Promise<true> => {
            throw new Error('rpc unavailable')
        })

        const idFromName = vi.fn(() => 'nonce-do-id')

        const env = testEnv({
            HTTP_AUTH_NONCE_MANAGER: httpAuthNonceNamespace({
                idFromName,
                get: vi.fn(() => ({ consumeNonce })),
            }),
        })

        const store = createHttpAuthNonceStore(env)
        await expect(store.consumeNonce('k:n', 120)).resolves.toBe(false)
    })
})
