import { z } from 'zod'

export const DEFAULT_AUTH_PROTECTED_METHODS = ['wallet_sendPreparedCalls'] as const

/**
 * These methods make the relayer sign and pay for gas. They stay authenticated
 * even when AUTH_PROTECTED_METHODS omits them or is "none".
 */
export const ALWAYS_AUTH_PROTECTED_METHODS = [
    'wallet_prepareUpgradeAccount',
    'wallet_upgradeAccount',
    'wallet_issueBindNonce',
    'wallet_bindAccount',
] as const

export type JsonRpcId = string | number | null

const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()])

const rpcPeekSchema = z
    .object({
        method: z.string(),
        id: z.unknown().optional(),
    })
    .passthrough()

const rpcIdOnlySchema = z
    .object({
        id: z.unknown().optional(),
    })
    .passthrough()

function coerceJsonRpcId(id: unknown): JsonRpcId {
    const parsed = jsonRpcIdSchema.safeParse(id)

    if (!parsed.success) return null

    return parsed.data
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

type AuthRequirement = { requiresAuth: boolean; id: JsonRpcId }

export function extractAuthRequirement(
    body: unknown,
    protectedMethods: Set<string>,
): AuthRequirement {
    if (Array.isArray(body)) {
        const requiresAuth = body.some((item) => {
            const parsed = rpcPeekSchema.safeParse(item)

            return parsed.success && protectedMethods.has(parsed.data.method)
        })

        return { requiresAuth, id: null }
    }

    const parsed = rpcPeekSchema.safeParse(body)

    if (parsed.success) {
        return {
            requiresAuth: protectedMethods.has(parsed.data.method),
            id: coerceJsonRpcId(parsed.data.id),
        }
    }

    const idOnly = rpcIdOnlySchema.safeParse(body)

    return {
        requiresAuth: false,
        id: idOnly.success ? coerceJsonRpcId(idOnly.data.id) : null,
    }
}
