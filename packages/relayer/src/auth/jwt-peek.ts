/**
 * Unverified JWT payload peek used only to route a bearer token to Privy or
 * OIDC. `jwtVerify` is the check that accepts a token.
 */
export function peekJwtIssuer(token: string): string | undefined {
    const payload = peekJwtPayload(token)

    return payload && typeof payload.iss === 'string' ? payload.iss : undefined
}

export function peekJwtHasAudience(token: string): boolean {
    const payload = peekJwtPayload(token)

    if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'aud')) return false

    return payload.aud !== null && payload.aud !== undefined
}

function peekJwtPayload(token: string): { iss?: unknown; aud?: unknown } | undefined {
    const parts = token.split('.')

    if (parts.length !== 3 || !parts[1]) return undefined

    try {
        return JSON.parse(decodeBase64Url(parts[1])) as { iss?: unknown; aud?: unknown }
    } catch {
        return undefined
    }
}

function decodeBase64Url(value: string): string {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
    const binary = atob(padded + pad)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index)
    }

    return new TextDecoder().decode(bytes)
}
