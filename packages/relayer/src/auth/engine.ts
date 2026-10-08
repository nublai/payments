import type { Env } from '../types/env'
import type { AuthFailure, AuthFailureCode, AuthProvider, AuthResult, AuthSuccess } from './types'
import { isIdentityProviderUnavailable } from './types'

const FAILURE_PRIORITY: AuthFailureCode[] = [
    'EXPIRED_TOKEN',
    'INVALID_TOKEN',
    'IDP_UNAVAILABLE',
    'PRIVY_API_UNAVAILABLE',
    'REPLAYED_NONCE',
    'MISSING_NONCE',
    'INVALID_TIME',
    'BAD_CONTENT_DIGEST',
    'INVALID_COVERAGE',
    'BAD_KEYID',
    'SIGNER_NOT_ALLOWED',
    'BAD_FORMAT',
    'MISSING_HEADERS',
    'UNSUPPORTED_CHAIN',
    'BAD_SIGNATURE',
    'NO_LINKED_WALLET',
]

export interface AuthorizeRequestArgs {
    request: Request
    env: Env
    nowSeconds: number
    providers: AuthProvider[]
}

export async function authorizeRequest(args: AuthorizeRequestArgs): Promise<AuthResult> {
    const enabledProviders = args.providers.filter((provider) => provider.enabled(args.env))

    if (enabledProviders.length === 0) {
        return {
            ok: false,
            code: 'BAD_SIGNATURE',
            message: 'No auth providers enabled',
        }
    }

    const failures: AuthFailure[] = []

    for (const provider of enabledProviders) {
        try {
            const result = await provider.verify(args.request.clone(), {
                env: args.env,
                nowSeconds: args.nowSeconds,
            })

            if (result.ok) {
                const success: AuthSuccess = {
                    ok: true,
                    provider: provider.name,
                    userId: result.userId,
                    boundAccounts: result.boundAccounts,
                }

                if (result.issuer) success.issuer = result.issuer

                return success
            }

            failures.push(result)
        } catch {
            failures.push(mapThrownProviderFailure(provider.name))
        }
    }

    return selectHighestPriorityFailure(failures)
}

function mapThrownProviderFailure(providerName: string): AuthFailure {
    if (providerName === 'privy') {
        return {
            ok: false,
            code: 'PRIVY_API_UNAVAILABLE',
            message: 'privy failed',
        }
    }

    if (providerName === 'oidc') {
        return {
            ok: false,
            code: 'IDP_UNAVAILABLE',
            message: 'oidc failed',
        }
    }

    return {
        ok: false,
        code: 'BAD_SIGNATURE',
        message: `${providerName} failed`,
    }
}

function selectHighestPriorityFailure(failures: AuthFailure[]): AuthFailure {
    const routed = failures.filter((failure) => !failure.routingMiss)
    const pool = routed.length > 0 ? routed : failures

    for (const code of FAILURE_PRIORITY) {
        const failure = pool.find((candidate) => failureMatches(code, candidate))

        if (failure) {
            return stripRoutingMiss(failure)
        }
    }

    return {
        ok: false,
        code: 'BAD_SIGNATURE',
        message: 'Authentication failed',
    }
}

function stripRoutingMiss(failure: AuthFailure): AuthFailure {
    if (!failure.routingMiss) return failure

    return { ok: false, code: failure.code, message: failure.message }
}

function failureMatches(code: AuthFailureCode, failure: AuthFailure): boolean {
    if (code === 'IDP_UNAVAILABLE' || code === 'PRIVY_API_UNAVAILABLE') {
        return isIdentityProviderUnavailable(failure.code)
    }

    return failure.code === code
}

export type { AuthProvider }
