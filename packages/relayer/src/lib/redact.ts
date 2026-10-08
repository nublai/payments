import type { Env } from '../types/env'
import type { JsonRpcErrorObject, JsonRpcResponse } from '../rpc/types'
import { getChainIds } from '../config'
import { getChainRpcUrl } from './multi-chain-client'

export const REDACTED = '[redacted]'

// Stops at quotes and backslashes so a URL inside serialized JSON ends at its string boundary or escape.
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`\\]+/gi

const SECRET_ENV_KEYS = [
    'RPC_URL',
    'RELAYER_MNEMONIC',
    'QUOTE_SIGNING_SECRET',
    'PRIVY_APP_SECRET',
    'COINGECKO_API_KEY',
    'COINGECKO_API_URL',
] as const satisfies readonly (keyof Env)[]

function chainRpcUrls(env: Env): string[] {
    return getChainIds(env).flatMap((chainId) => {
        try {
            return [getChainRpcUrl(chainId, env)]
        } catch {
            return []
        }
    })
}

function secretValues(env: Env): string[] {
    const values = [...SECRET_ENV_KEYS.map((key) => env[key] ?? ''), ...chainRpcUrls(env)]

    // Longest first so a secret that contains another is replaced whole.
    return [...new Set(values.filter((value) => value.trim().length > 0))].sort(
        (a, b) => b.length - a.length,
    )
}

/** Replace URLs and configured secret values in text that leaves the worker. */
export function redactSecrets(text: string, env: Env): string {
    const withoutSecrets = secretValues(env).reduce(
        (redacted, secret) => redacted.split(secret).join(REDACTED),
        text,
    )

    return withoutSecrets.replace(URL_PATTERN, REDACTED)
}

function redactErrorObject(error: JsonRpcErrorObject, env: Env): JsonRpcErrorObject {
    const serialized = JSON.stringify(error)
    const secrets = secretValues(env).map((secret) => JSON.stringify(secret).slice(1, -1))

    const redacted = secrets
        .reduce((text, secret) => text.split(secret).join(REDACTED), serialized)
        .replace(URL_PATTERN, REDACTED)

    // SAFETY: `redacted` is `serialized` with string contents replaced by a JSON-safe placeholder, so it parses back to the same shape.
    return JSON.parse(redacted) as JsonRpcErrorObject
}

function redactResponse(response: JsonRpcResponse, env: Env): JsonRpcResponse {
    if (!response.error) return response

    return { ...response, error: redactErrorObject(response.error, env) }
}

/** Redact the error object of every JSON-RPC response. Results and codes are unchanged. */
export function redactRpcResponse(
    response: JsonRpcResponse | JsonRpcResponse[],
    env: Env,
): JsonRpcResponse | JsonRpcResponse[] {
    if (Array.isArray(response)) return response.map((item) => redactResponse(item, env))

    return redactResponse(response, env)
}
