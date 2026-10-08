/**
 * Only `CONTEXT=local` may skip quote HMAC, allow an http JWKS URL, and leave
 * ERC-8128 open. `dev` is the Base Sepolia deployment context and does not get
 * those exceptions. Unset CONTEXT is not local.
 */
export function isLocalDevContext(env: { CONTEXT?: string } | null | undefined): boolean {
    const context = env?.CONTEXT?.trim().toLowerCase()

    return context === 'local'
}

export function quoteSigningSecret(
    env: { QUOTE_SIGNING_SECRET?: string } | null | undefined,
): string | undefined {
    const secret = env?.QUOTE_SIGNING_SECRET?.trim()

    return secret ? secret : undefined
}
