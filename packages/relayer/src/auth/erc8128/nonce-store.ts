import type { NonceStore } from './verify'
import type { Env } from '../../types/env'

const GLOBAL_NONCE_OBJECT = 'http-auth-nonces'

export function createHttpAuthNonceStore(env: Env): NonceStore {
    return {
        async consumeNonce(replayKey: string, ttlSeconds: number): Promise<boolean> {
            if (!env.HTTP_AUTH_NONCE_MANAGER) {
                throw new Error('HTTP_AUTH_NONCE_MANAGER binding is missing')
            }

            const id = env.HTTP_AUTH_NONCE_MANAGER.idFromName(GLOBAL_NONCE_OBJECT)
            const stub = env.HTTP_AUTH_NONCE_MANAGER.get(id)

            try {
                return await stub.consumeNonce(replayKey, ttlSeconds)
            } catch {
                return false
            }
        },
    }
}
