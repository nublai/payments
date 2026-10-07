/**
 * JSON-RPC 2.0 Transport Layer
 *
 * Provides a transport for making JSON-RPC calls to the relayer.
 */

import { signRequest } from '@slicekit/erc8128'
import type { HttpAuthOptions } from './httpAuth'
import { getHttpAuthOptions } from './httpAuth'
import type { RelayerPublicClient } from './types'

// =============================================================================
// Types
// =============================================================================

/**
 * JSON-RPC 2.0 Request object
 */
export interface JsonRpcRequest {
    jsonrpc: '2.0'
    id: number
    method: string
    params?: unknown[]
}

/**
 * JSON-RPC 2.0 Response object
 */
export interface JsonRpcResponse<T = unknown> {
    jsonrpc: '2.0'
    id: number
    result?: T
    error?: JsonRpcError
}

/**
 * JSON-RPC 2.0 Error object
 */
export interface JsonRpcError {
    code: number
    message: string
    data?: unknown
}

export interface JsonRpcTransportOptions {
    httpAuth?: HttpAuthOptions
    /**
     * Allow plain http to a non-loopback host.
     * Wallet dev sets this. Prod and stage leave it unset.
     */
    allowInsecureHttp?: boolean
}

function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * Prod and stage relayer URLs must be https unless the host is loopback.
 * Local dev may pass allowInsecureHttp. Loopback http is always allowed.
 */
export function assertRelayerUrl(relayerUrl: string, options?: { allowInsecureHttp?: boolean }): void {
    let url: URL
    try {
        url = new URL(relayerUrl)
    } catch {
        throw new Error(`Invalid relayer URL: ${relayerUrl}`)
    }
    if (url.protocol === 'https:') return
    if (url.protocol === 'http:' && (isLoopbackHost(url.hostname) || options?.allowInsecureHttp)) return
    throw new Error(
        `Relayer URL must use https when the host is not loopback outside local dev. Refusing ${relayerUrl}`,
    )
}

/**
 * JSON-RPC Transport interface
 */
export interface JsonRpcTransport {
    /**
     * Make a JSON-RPC call
     * @param method - The RPC method name
     * @param params - Optional parameters (will be wrapped in array)
     * @returns The result from the RPC call
     * @throws JsonRpcClientError if the call fails
     */
    request<T>(method: string, params?: unknown): Promise<T>

    /**
     * Make a batch JSON-RPC call
     * @param requests - Array of { method, params } objects
     * @returns Array of results in the same order as requests
     * @throws JsonRpcClientError if any request fails
     */
    requestBatch<T>(requests: Array<{ method: string; params?: unknown }>): Promise<T[]>
}

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Error thrown when a JSON-RPC call fails
 */
export class JsonRpcClientError extends Error {
    public readonly code: number
    public readonly data?: unknown

    constructor(code: number, message: string, data?: unknown) {
        super(message)
        this.name = 'JsonRpcClientError'
        this.code = code
        this.data = data
    }
}

async function postJson(relayerUrl: string, body: string, options?: JsonRpcTransportOptions) {
    const authToken = await resolveBearerToken(options)
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (authToken) {
        headers.set('Authorization', `Bearer ${authToken}`)
    }

    const request = new Request(relayerUrl, {
        method: 'POST',
        headers,
        body,
    })

    const httpAuth = options?.httpAuth
    if (!httpAuth?.signer) {
        return fetch(request)
    }

    const signedRequest = await signRequest(request, httpAuth.signer, httpAuth.signOptions)
    return fetch(signedRequest)
}

async function resolveBearerToken(options?: JsonRpcTransportOptions): Promise<string | null> {
    const provider = options?.httpAuth?.authTokenProvider
    if (provider) {
        try {
            const resolved = await provider()
            const trimmed = resolved?.trim()
            return trimmed && trimmed.length > 0 ? trimmed : null
        } catch (error) {
            throw new JsonRpcClientError(-32000, 'Failed to resolve auth token', {
                stage: 'authTokenProvider',
                cause: error instanceof Error ? error.message : String(error),
            })
        }
    }

    const token = options?.httpAuth?.authToken?.trim()
    return token && token.length > 0 ? token : null
}

// =============================================================================
// Transport Implementation
// =============================================================================

/**
 * Create a JSON-RPC transport for the given relayer URL
 *
 * @param relayerUrl - The base URL of the relayer (JSON-RPC endpoint at root)
 * @returns A transport object with a request method
 *
 * @example
 * ```typescript
 * const transport = createJsonRpcTransport('https://relayer.example.com')
 *
 * // Make a call
 * const health = await transport.request<{ version: string }>('wallet_health')
 *
 * // Make a call with params
 * const status = await transport.request<StatusResult>('wallet_getCallsStatus', bundleId)
 * ```
 */
export function createJsonRpcTransport(
    relayerUrl: string,
    options?: JsonRpcTransportOptions,
): JsonRpcTransport {
    assertRelayerUrl(relayerUrl, options)
    let requestId = 0

    return {
        async request<T>(method: string, params?: unknown): Promise<T> {
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id: ++requestId,
                method,
                // Wrap params in array as per JSON-RPC spec and api-routes-plan
                params: params !== undefined ? [params] : [],
            }

            const response = await postJson(relayerUrl, JSON.stringify(request), options)

            if (!response.ok) {
                throw new JsonRpcClientError(
                    -32000,
                    `HTTP error: ${response.status} ${response.statusText}`,
                )
            }

            const data = (await response.json()) as JsonRpcResponse<T>

            if (data.error) {
                throw new JsonRpcClientError(data.error.code, data.error.message, data.error.data)
            }

            return data.result as T
        },

        async requestBatch<T>(requests: Array<{ method: string; params?: unknown }>): Promise<T[]> {
            const batchRequest: JsonRpcRequest[] = requests.map((req) => ({
                jsonrpc: '2.0',
                id: ++requestId,
                method: req.method,
                params: req.params !== undefined ? [req.params] : [],
            }))

            const response = await postJson(relayerUrl, JSON.stringify(batchRequest), options)

            if (!response.ok) {
                throw new JsonRpcClientError(
                    -32000,
                    `HTTP error: ${response.status} ${response.statusText}`,
                )
            }

            const json = (await response.json()) as JsonRpcResponse<T>[] | JsonRpcResponse<T>
            const data = Array.isArray(json) ? json : [json]

            // Some relayer middleware paths may return a single JSON-RPC error object
            // for the whole batch request. Surface it as a typed client error.
            if (!Array.isArray(json)) {
                if (json.error) {
                    throw new JsonRpcClientError(
                        json.error.code,
                        json.error.message,
                        json.error.data,
                    )
                }
                throw new JsonRpcClientError(-32000, 'Invalid JSON-RPC batch response')
            }

            // Check for any errors in the batch response
            for (const item of data) {
                if (item.error) {
                    throw new JsonRpcClientError(
                        item.error.code,
                        item.error.message,
                        item.error.data,
                    )
                }
            }

            // Sort by id to maintain request order and extract results
            const sorted = data.sort((a, b) => a.id - b.id)
            return sorted.map((item) => item.result as T)
        },
    }
}

export function createRelayerTransport(client: RelayerPublicClient): JsonRpcTransport {
    return createJsonRpcTransport(client.relayerConfig.relayerUrl, {
        httpAuth: getHttpAuthOptions(client.relayerConfig),
        allowInsecureHttp: client.relayerConfig.allowInsecureHttp,
    })
}
