/**
 * Local/dev is the only context that may skip quote HMAC and open ERC-8128.
 * Unset CONTEXT is not local: stage and prod fail closed, and so does a worker
 * that forgot to set the variable.
 */
export function isLocalDevContext(env: { CONTEXT?: string } | null | undefined): boolean {
    const context = env?.CONTEXT?.trim().toLowerCase()
    return context === 'local' || context === 'dev'
}

export function quoteSigningSecret(
    env: { QUOTE_SIGNING_SECRET?: string } | null | undefined,
): string | undefined {
    const secret = env?.QUOTE_SIGNING_SECRET?.trim()
    return secret ? secret : undefined
}
