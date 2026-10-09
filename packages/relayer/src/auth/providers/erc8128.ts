import type { Env } from '../../types/env'
import { createHttpAuthNonceStore } from '../erc8128/nonce-store'
import { getErc8128Policy } from '../erc8128/policy'
import { verifyErc8128Request, type Erc8128Config } from '../erc8128/verify'
import type { AuthProvider, AuthResult } from '../types'

export type Erc8128ProviderDeps = {
    verify?: typeof verifyErc8128Request
    getChainClient?: Erc8128Config['getChainClient']
}

export function createErc8128Provider(deps: Erc8128ProviderDeps = {}): AuthProvider {
    const verify = deps.verify ?? verifyErc8128Request

    return {
        name: 'erc8128',
        enabled(env: Env): boolean {
            return env.ERC8128_ENABLED === 'true'
        },
        async verify(request: Request, ctx: { env: Env; nowSeconds: number }): Promise<AuthResult> {
            if (!ctx.env.HTTP_AUTH_NONCE_MANAGER) {
                return {
                    ok: false,
                    code: 'BAD_SIGNATURE',
                    message: 'HTTP auth nonce manager not configured',
                }
            }

            const policy = getErc8128Policy(ctx.env)

            try {
                const result = await verify(
                    {
                        env: ctx.env,
                        request,
                        nowSeconds: ctx.nowSeconds,
                    },
                    {
                        maxValiditySeconds: policy.maxValiditySeconds,
                        clockSkewSeconds: policy.clockSkewSeconds,
                        requireRequestBound: policy.requireRequestBound,
                        requireNonReplayable: policy.requireNonReplayable,
                        nonceStore: createHttpAuthNonceStore(ctx.env),
                        getChainClient: deps.getChainClient,
                    },
                )

                if (result.ok) {
                    return { ok: true, userId: result.keyId.address }
                }

                return {
                    ok: false,
                    code: result.code,
                    message: result.message,
                }
            } catch {
                return {
                    ok: false,
                    code: 'BAD_SIGNATURE',
                    message: 'erc8128 failed',
                }
            }
        },
    }
}
