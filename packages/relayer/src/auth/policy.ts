export const DEFAULT_AUTH_PROTECTED_METHODS = ['wallet_sendPreparedCalls'] as const

/**
 * These methods make the relayer sign and pay for gas. They stay authenticated
 * even when AUTH_PROTECTED_METHODS omits them or is "none".
 */
export const ALWAYS_AUTH_PROTECTED_METHODS = [
    'wallet_prepareUpgradeAccount',
    'wallet_upgradeAccount',
] as const

export type JsonRpcId = string | number | null

interface JsonRpcLike {
    id?: JsonRpcId | unknown
    method?: unknown
}

function coerceJsonRpcId(id: unknown): JsonRpcId {
    if (id === null || typeof id === 'string' || typeof id === 'number') {
        return id
    }
    return null
}

export function parseAuthProtectedMethods(value: string | undefined): Set<string> {
    if (!value) {
        return new Set(DEFAULT_AUTH_PROTECTED_METHODS)
    }

    if (value.trim().toLowerCase() === 'none') {
        return new Set()
    }

    const methods = value
        .split(',')
        .map((method) => method.trim())
        .filter((method) => method.length > 0)

    return new Set(methods.length > 0 ? methods : DEFAULT_AUTH_PROTECTED_METHODS)
}

export function resolveAuthProtectedMethods(value: string | undefined): Set<string> {
    const methods = parseAuthProtectedMethods(value)
    for (const method of ALWAYS_AUTH_PROTECTED_METHODS) {
        methods.add(method)
    }
    return methods
}

export function extractAuthRequirement(
    body: unknown,
    protectedMethods: Set<string>,
): { requiresAuth: boolean; id: JsonRpcId } {
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
        id: coerceJsonRpcId(req.id),
    }
}
