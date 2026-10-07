import type { Env } from '../types/env'
import { peekJwtIssuer } from './jwt-peek'

export interface OidcConfig {
    issuer: string
    jwksUrl: string
    clientId: string
    walletsClaim: string
}

const WALLETS_CLAIM_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

export function isOidcEnabled(env: { OIDC_ENABLED?: string }): boolean {
    return env.OIDC_ENABLED === 'true'
}

/**
 * Privy stays on unless the flag is the string `false`. Unset matches the
 * previous deployments that do not set the flag and still expect Privy.
 * Explicit `true` is unchanged. Any other value is off.
 */
export function isPrivyEnabled(env: { PRIVY_ENABLED?: string }): boolean {
    const flag = env.PRIVY_ENABLED?.trim()
    if (flag === undefined || flag === '') return true
    return flag === 'true'
}

export function readOidcConfig(
    env: Env,
): { ok: true; config: OidcConfig } | { ok: false; missing: string[] } {
    const missing: string[] = []
    const issuer = env.OIDC_ISSUER?.trim() ?? ''
    const jwksUrl = env.OIDC_JWKS_URL?.trim() ?? ''
    const clientId = env.OIDC_CLIENT_ID?.trim() ?? ''
    if (!isHttpUrl(issuer)) missing.push('OIDC_ISSUER')
    if (!isHttpUrl(jwksUrl)) missing.push('OIDC_JWKS_URL')
    if (!clientId) missing.push('OIDC_CLIENT_ID')

    const walletsClaim = env.OIDC_WALLETS_CLAIM?.trim() || 'wallets'
    if (!WALLETS_CLAIM_PATTERN.test(walletsClaim)) missing.push('OIDC_WALLETS_CLAIM')

    if (missing.length > 0) return { ok: false, missing }
    return { ok: true, config: { issuer, jwksUrl, clientId, walletsClaim } }
}

/** Route an OIDC-shaped token away from Privy before Privy calls its API. */
export function tokenTargetsOidc(token: string, env: Env): boolean {
    if (!isOidcEnabled(env)) return false
    const issuer = env.OIDC_ISSUER?.trim()
    if (!issuer) return false
    return peekJwtIssuer(token) === issuer
}

function isHttpUrl(value: string): boolean {
    if (!value) return false
    try {
        const url = new URL(value)
        return url.protocol === 'https:' || url.protocol === 'http:'
    } catch {
        return false
    }
}
