import { getAddress, isAddress, type Address } from 'viem'
import { PrivyClient } from '@privy-io/server-auth'

import type { Env } from '../../types/env'
import { authProviderFromIdentity, type IdentityProvider, type IdentityResult } from '../identity-provider'
import { isPrivyEnabled, tokenTargetsOidc } from '../oidc-config'
import type { AuthProvider } from '../types'

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

const UPGRADE_METHODS = new Set(['wallet_prepareUpgradeAccount', 'wallet_upgradeAccount'])

function upgradeAccountAddress(method: string, params: unknown): Address | 'invalid' | undefined {
    const first = Array.isArray(params) ? params[0] : params

    if (!first || typeof first !== 'object') return 'invalid'
    const record = first as Record<string, unknown>

    const raw =
        method === 'wallet_upgradeAccount'
            ? (record.context as { address?: unknown } | undefined)?.address
            : record.address

    if (typeof raw !== 'string' || !isAddress(raw)) return 'invalid'

    return getAddress(raw)
}

async function upgradeAccountsFromRequest(
    request: Request,
): Promise<{ accounts: Address[]; invalid: boolean }> {
    const body = await request
        .clone()
        .json()
        .catch(() => undefined)

    const items = Array.isArray(body) ? body : body == null ? [] : [body]
    const accounts: Address[] = []
    let invalid = false

    for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const method = (item as { method?: unknown }).method

        if (typeof method !== 'string' || !UPGRADE_METHODS.has(method)) continue
        const address = upgradeAccountAddress(method, (item as { params?: unknown }).params)

        if (address === 'invalid' || address === undefined) {
            invalid = true
            continue
        }

        if (!accounts.includes(address)) accounts.push(address)
    }

    return { accounts, invalid }
}

function linkedWalletMatches(
    user: {
        wallet?: { address?: string }
        linkedAccounts?: Array<{ type?: string; address?: string }>
    },
    account: Address,
): boolean {
    const target = getAddress(account)
    const candidates: string[] = []

    for (const linked of user.linkedAccounts ?? []) {
        if (linked.type === 'wallet' && typeof linked.address === 'string') {
            candidates.push(linked.address)
        }
    }

    return candidates.some((candidate) => isAddress(candidate) && getAddress(candidate) === target)
}

async function bindPrivyAccounts(
    client: PrivyClient,
    userId: string,
    accounts: Address[],
): Promise<
    { ok: true; accounts: Address[] } | { ok: false; code: 'NO_LINKED_WALLET'; message: string }
> {
    for (const account of accounts) {
        const user = await client.getUserByWalletAddress(account)

        if (!user || user.id !== userId || !linkedWalletMatches(user, account)) {
            return {
                ok: false,
                code: 'NO_LINKED_WALLET',
                message: 'Privy user is not bound to the account',
            }
        }
    }

    return { ok: true, accounts }
}

function requestFromIdentityInput(input: Request | string): Request {
    if (typeof input !== 'string') return input

    return new Request('https://relayer.local/', {
        headers: { Authorization: `Bearer ${input}` },
    })
}

/**
 * Privy is the only identity provider in this process. `verify` returns the
 * identity shape (`provider`, `userId`, `boundAccounts`) so another provider
 * can sit beside it in the registry without a change to the identity gate.
 */
export function createPrivyIdentityProvider(): IdentityProvider {
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
            return isPrivyEnabled(env)
        },
        async verify(input: Request | string, ctx: { env: Env; nowSeconds: number }): Promise<IdentityResult> {
            const request = requestFromIdentityInput(input)
            const parsed = parseBearerToken(request)

            if (!parsed.ok) {
                return {
                    ok: false,
                    code: 'INVALID_TOKEN',
                    message: parsed.message,
                }
            }

            if (tokenTargetsOidc(parsed.token, ctx.env)) {
                return {
                    ok: false,
                    code: 'INVALID_TOKEN',
                    message: 'Token issuer mismatch',
                    routingMiss: true,
                }
            }

            if (!ctx.env.PRIVY_APP_ID || !ctx.env.PRIVY_APP_SECRET) {
                return {
                    ok: false,
                    code: 'INVALID_TOKEN',
                    message: 'Privy is not configured',
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

                const upgradeAccounts = await upgradeAccountsFromRequest(request)

                if (upgradeAccounts.invalid) {
                    return {
                        ok: false,
                        code: 'NO_LINKED_WALLET',
                        message: 'Privy user is not bound to the account',
                    }
                }

                if (upgradeAccounts.accounts.length > 0) {
                    const linked = await bindPrivyAccounts(
                        getClient(ctx.env),
                        claims.userId,
                        upgradeAccounts.accounts,
                    )

                    if (!linked.ok) return linked

                    return {
                        ok: true,
                        provider: 'privy',
                        userId: claims.userId,
                        boundAccounts: linked.accounts,
                    }
                }

                return { ok: true, provider: 'privy', userId: claims.userId, boundAccounts: [] }
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

/** HTTP auth adapter. Existing callers and tests keep the AuthProvider result shape. */
export function createPrivyProvider(): AuthProvider {
    return authProviderFromIdentity(createPrivyIdentityProvider())
}
