import type { Env } from '../types/env'
import type { AuthFailure, AuthFailureCode, AuthProvider, AuthResult } from './types'

const FAILURE_PRIORITY: AuthFailureCode[] = [
    'EXPIRED_TOKEN',
    'INVALID_TOKEN',
    'PRIVY_API_UNAVAILABLE',
    'REPLAYED_NONCE',
    'MISSING_NONCE',
    'INVALID_TIME',
    'BAD_CONTENT_DIGEST',
    'INVALID_COVERAGE',
    'BAD_KEYID',
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
                return {
                    ok: true,
                    provider: provider.name,
                    userId: result.userId,
                }
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

    return {
        ok: false,
        code: 'BAD_SIGNATURE',
        message: `${providerName} failed`,
    }
}

function selectHighestPriorityFailure(failures: AuthFailure[]): AuthFailure {
    for (const code of FAILURE_PRIORITY) {
        const failure = failures.find((candidate) => candidate.code === code)
        if (failure) {
            return failure
        }
    }

    return {
        ok: false,
        code: 'BAD_SIGNATURE',
        message: 'Authentication failed',
    }
}

export type { AuthProvider }
