import type { MiddlewareHandler } from 'hono'

import type { Env } from '../../types/env'
import { createHttpAuthNonceStore } from './nonce-store'
import { getErc8128Policy } from './policy'
import { verifyErc8128Request, type Erc8128VerifyFailure, type NonceStore } from './verify'

interface JsonRpcLike {
    id?: unknown
    method?: unknown
}

interface MiddlewareDeps {
    verify?: typeof verifyErc8128Request
    nowSeconds?: () => number
    createNonceStore?: (env: Env) => NonceStore
}

function extractAuthRequirement(
    body: unknown,
    protectedMethods: Set<string>,
): { requiresAuth: boolean; id: unknown | null } {
    if (Array.isArray(body)) {
        const requiresAuth = body.some(
            (item) =>
                !!item &&
                typeof item === 'object' &&
                typeof (item as JsonRpcLike).method === 'string' &&
                protectedMethods.has((item as JsonRpcLike).method as string),
        )

        return { requiresAuth, id: null }
    }

    if (!body || typeof body !== 'object') {
        return { requiresAuth: false, id: null }
    }

    const req = body as JsonRpcLike
    const method = typeof req.method === 'string' ? req.method : undefined

    return {
        requiresAuth: !!method && protectedMethods.has(method),
        id: req.id ?? null,
    }
}

function unauthorizedResponse(id: unknown | null, failure: Erc8128VerifyFailure) {
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

function unexpectedAuthFailure(): Erc8128VerifyFailure {
    return {
        ok: false,
        code: 'BAD_SIGNATURE',
        message: 'Unexpected verification failure',
    }
}

export function erc8128AuthMiddleware(deps: MiddlewareDeps = {}): MiddlewareHandler<{
    Bindings: Env
}> {
    const verify = deps.verify ?? verifyErc8128Request
    const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
    const makeNonceStore = deps.createNonceStore ?? createHttpAuthNonceStore

    return async (c, next) => {
        if (c.req.method !== 'POST' || c.req.path !== '/') {
            return next()
        }

        const policy = getErc8128Policy(c.env)

        if (!policy.enabled) {
            return next()
        }

        const payload = await c.req.raw
            .clone()
            .json()
            .catch(() => undefined)

        const { requiresAuth, id } = extractAuthRequirement(payload, policy.protectedMethods)

        if (!requiresAuth) {
            return next()
        }

        if (!c.env.HTTP_AUTH_NONCE_MANAGER) {
            return c.json({ success: false, error: 'HTTP auth nonce manager not configured' }, 500)
        }

        let result

        try {
            result = await verify(
                {
                    env: c.env,
                    request: c.req.raw.clone(),
                    nowSeconds: nowSeconds(),
                },
                {
                    maxValiditySeconds: policy.maxValiditySeconds,
                    clockSkewSeconds: policy.clockSkewSeconds,
                    requireRequestBound: policy.requireRequestBound,
                    requireNonReplayable: policy.requireNonReplayable,
                    nonceStore: makeNonceStore(c.env),
                },
            )
        } catch {
            return c.json(unauthorizedResponse(id, unexpectedAuthFailure()), 200)
        }

        if (!result.ok) {
            return c.json(unauthorizedResponse(id, result), 200)
        }

        await next()
    }
}

export { extractAuthRequirement }
