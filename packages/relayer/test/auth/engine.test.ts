import { describe, expect, it } from 'vitest'

import { authorizeRequest, type AuthProvider } from '../../src/auth/engine'
import type { AuthFailureCode } from '../../src/auth/types'
import { testEnv } from '../helpers/env'

function createProvider(args: {
    name: string
    enabled?: boolean
    result?: { ok: true; userId?: string } | { ok: false; code: AuthFailureCode; message: string }
    throws?: boolean
}): AuthProvider {
    return {
        name: args.name,
        enabled: () => args.enabled ?? true,
        verify: async () => {
            if (args.throws) {
                throw new Error(`${args.name} failed`)
            }

            return args.result ?? { ok: true }
        },
    }
}

describe('auth engine', () => {
    const request = new Request('https://relayer.example.com/', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'wallet_sendPreparedCalls' }),
    })

    const env = testEnv()

    it('authorizes when any enabled provider succeeds', async () => {
        const result = await authorizeRequest({
            request,
            env,
            nowSeconds: 1_700_000_000,
            providers: [
                createProvider({
                    name: 'privy',
                    result: { ok: false, code: 'INVALID_TOKEN', message: 'invalid' },
                }),
                createProvider({ name: 'erc8128', result: { ok: true, userId: '0xabc' } }),
            ],
        })

        expect(result.ok).toBe(true)

        if (result.ok) {
            expect(result.provider).toBe('erc8128')
            expect(result.userId).toBe('0xabc')
        }
    })

    it('returns deterministic highest-priority failure when all providers fail', async () => {
        const result = await authorizeRequest({
            request,
            env,
            nowSeconds: 1_700_000_000,
            providers: [
                createProvider({
                    name: 'erc8128',
                    result: { ok: false, code: 'BAD_SIGNATURE', message: 'bad sig' },
                }),
                createProvider({
                    name: 'privy',
                    result: { ok: false, code: 'EXPIRED_TOKEN', message: 'expired' },
                }),
            ],
        })

        expect(result).toEqual({ ok: false, code: 'EXPIRED_TOKEN', message: 'expired' })
    })

    it('normalizes thrown provider error and still evaluates remaining providers', async () => {
        const result = await authorizeRequest({
            request,
            env,
            nowSeconds: 1_700_000_000,
            providers: [
                createProvider({ name: 'privy', throws: true }),
                createProvider({
                    name: 'erc8128',
                    result: { ok: false, code: 'BAD_SIGNATURE', message: 'bad sig' },
                }),
            ],
        })

        expect(result).toEqual({
            ok: false,
            code: 'PRIVY_API_UNAVAILABLE',
            message: 'privy failed',
        })
    })

    it('returns failure when no providers are enabled', async () => {
        const result = await authorizeRequest({
            request,
            env,
            nowSeconds: 1_700_000_000,
            providers: [
                createProvider({ name: 'privy', enabled: false }),
                createProvider({ name: 'erc8128', enabled: false }),
            ],
        })

        expect(result).toEqual({
            ok: false,
            code: 'BAD_SIGNATURE',
            message: 'No auth providers enabled',
        })
    })

    it('returns IDP_UNAVAILABLE when the OIDC provider throws', async () => {
        const result = await authorizeRequest({
            request,
            env,
            nowSeconds: 1_700_000_000,
            providers: [
                createProvider({ name: 'oidc', throws: true }),
                createProvider({
                    name: 'erc8128',
                    result: { ok: false, code: 'BAD_SIGNATURE', message: 'bad sig' },
                }),
            ],
        })

        expect(result).toEqual({
            ok: false,
            code: 'IDP_UNAVAILABLE',
            message: 'oidc failed',
        })
    })

    it('still returns PRIVY_API_UNAVAILABLE as the alias when that is the failure', async () => {
        const result = await authorizeRequest({
            request,
            env,
            nowSeconds: 1_700_000_000,
            providers: [
                createProvider({
                    name: 'privy',
                    result: {
                        ok: false,
                        code: 'PRIVY_API_UNAVAILABLE',
                        message: 'Privy API unavailable',
                    },
                }),
                createProvider({
                    name: 'erc8128',
                    result: { ok: false, code: 'BAD_SIGNATURE', message: 'bad sig' },
                }),
            ],
        })

        expect(result).toEqual({
            ok: false,
            code: 'PRIVY_API_UNAVAILABLE',
            message: 'Privy API unavailable',
        })
    })
})
