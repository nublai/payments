import type { Env } from '../../types/env'
import type { AuthProvider, AuthResult } from '../types'
import { PrivyClient } from '@privy-io/server-auth'

function parseBearerToken(
    request: Request,
): { ok: true; token: string } | { ok: false; message: string } {
    const header = request.headers.get('Authorization')
    if (!header) {
        return { ok: false, message: 'Missing Authorization header' }
    }

    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match || !match[1] || match[1].trim().length === 0) {
        return { ok: false, message: 'Invalid Authorization header format' }
    }

    return { ok: true, token: match[1].trim() }
}

function classifyPrivyError(error: unknown): {
    code: 'EXPIRED_TOKEN' | 'PRIVY_API_UNAVAILABLE' | 'INVALID_TOKEN'
} {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase()

    if (message.includes('expired') || message.includes('exp claim')) {
        return { code: 'EXPIRED_TOKEN' as const }
    }

    if (
        message.includes('fetch failed') ||
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('503') ||
        message.includes('502') ||
        message.includes('500') ||
        message.includes('unavailable')
    ) {
        return { code: 'PRIVY_API_UNAVAILABLE' as const }
    }

    return { code: 'INVALID_TOKEN' as const }
}

export function createPrivyProvider(): AuthProvider {
    let client: PrivyClient | undefined

    function getClient(env: Env): PrivyClient {
        if (!client) {
            client = new PrivyClient(env.PRIVY_APP_ID ?? '', env.PRIVY_APP_SECRET ?? '')
        }

        return client
    }

    return {
        name: 'privy',
        enabled(env: Env): boolean {
            return env.PRIVY_ENABLED === 'true'
        },
        async verify(request: Request, ctx: { env: Env; nowSeconds: number }): Promise<AuthResult> {
            const parsed = parseBearerToken(request)
            if (!parsed.ok) {
                return {
                    ok: false,
                    code: 'INVALID_TOKEN',
                    message: parsed.message,
                }
            }

            try {
                const claims = await getClient(ctx.env).verifyAuthToken(parsed.token)
                const claimsRecord = (claims ?? {}) as unknown as Record<string, unknown>
                const tokenAppId =
                    typeof claimsRecord.appId === 'string'
                        ? claimsRecord.appId
                        : typeof claimsRecord.app_id === 'string'
                          ? claimsRecord.app_id
                          : undefined

                if (tokenAppId !== ctx.env.PRIVY_APP_ID) {
                    return {
                        ok: false,
                        code: 'INVALID_TOKEN',
                        message: 'Token appId mismatch',
                    }
                }

                return { ok: true, userId: claims.userId }
            } catch (error) {
                const classified = classifyPrivyError(error)

                if (classified.code === 'EXPIRED_TOKEN') {
                    return {
                        ok: false,
                        code: 'EXPIRED_TOKEN',
                        message: 'Token has expired',
                    }
                }

                if (classified.code === 'PRIVY_API_UNAVAILABLE') {
                    return {
                        ok: false,
                        code: 'PRIVY_API_UNAVAILABLE',
                        message: 'Privy API unavailable',
                    }
                }

                return {
                    ok: false,
                    code: 'INVALID_TOKEN',
                    message: 'Invalid or expired token',
                }
            }
        },
    }
}
