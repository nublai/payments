import type { MiddlewareHandler } from 'hono'

import { logger } from '../lib/logger'
import type { Env } from '../types/env'
import { setRpcCaller } from './caller'
import { authorizeRequest } from './engine'
import { runWithAuthIdentity } from './identity'
import { extractAuthRequirement, resolveAuthProtectedMethods } from './policy'
import type { AuthFailure, AuthProvider } from './types'

interface MiddlewareDeps {
    providers?: AuthProvider[]
    nowSeconds?: () => number
}

function unauthorizedResponse(id: unknown | null, failure: AuthFailure) {
    return {
        jsonrpc: '2.0' as const,
        id,
        error: {
            code: -32001,
            message: 'Unauthorized',
            data: {
                auth_code: failure.code,
            },
        },
    }
}

export function authMiddleware(deps: MiddlewareDeps = {}): MiddlewareHandler<{
    Bindings: Env
}> {
    const providers = deps.providers ?? []
    const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))

    return async (c, next) => {
        if (c.req.method !== 'POST' || c.req.path !== '/') {
            return next()
        }

        const payload = await c.req.raw
            .clone()
            .json()
            .catch(() => undefined)

        const protectedMethods = resolveAuthProtectedMethods(c.env.AUTH_PROTECTED_METHODS)
        const { requiresAuth, id } = extractAuthRequirement(payload, protectedMethods)

        if (!requiresAuth) {
            return next()
        }

        logger.info(
            {
                method: c.req.method,
                path: c.req.path,
                id,
                requiresAuth: true,
            },
            'auth middleware invoked',
        )

        const result = await authorizeRequest({
            request: c.req.raw,
            env: c.env,
            nowSeconds: nowSeconds(),
            providers,
        })

        if (!result.ok) {
            logger.warn(
                {
                    method: c.req.method,
                    path: c.req.path,
                    id,
                    authCode: result.code,
                },
                'auth middleware unauthorized',
            )
            return c.json(unauthorizedResponse(id, result), 200)
        }

        setRpcCaller(c.req.raw, {
            provider: result.provider,
            userId: typeof result.userId === 'string' ? result.userId : undefined,
            issuer: result.issuer,
        })

        logger.info(
            {
                method: c.req.method,
                path: c.req.path,
                id,
                provider: result.provider,
                userId: result.userId,
            },
            'auth middleware authorized',
        )

        return runWithAuthIdentity(
            {
                provider: result.provider ?? '',
                userId: typeof result.userId === 'string' ? result.userId : '',
                issuer: result.issuer,
                boundAccounts: result.boundAccounts,
            },
            () => next(),
        )
    }
}
