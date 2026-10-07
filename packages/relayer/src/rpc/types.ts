/**
 * JSON-RPC 2.0 Types
 *
 * Standard types for JSON-RPC 2.0 protocol as defined in https://www.jsonrpc.org/specification
 */

/**
 * JSON-RPC 2.0 Request object
 */
export interface JsonRpcRequest {
    /** Must be exactly "2.0" */
    jsonrpc: '2.0'
    /** Request identifier. Can be string, number, or null for notifications */
    id: string | number | null
    /** Method name to invoke */
    method: string
    /** Optional parameters - either array (positional) or object (named) */
    params?: unknown[] | Record<string, unknown>
}

/**
 * JSON-RPC 2.0 Response object
 */
export interface JsonRpcResponse {
    /** Must be exactly "2.0" */
    jsonrpc: '2.0'
    /** Must match the id from the request */
    id: string | number | null
    /** Result on success (mutually exclusive with error) */
    result?: unknown
    /** Error on failure (mutually exclusive with result) */
    error?: JsonRpcErrorObject
}

/**
 * JSON-RPC 2.0 Error object
 */
export interface JsonRpcErrorObject {
    /** Error code (integer) */
    code: number
    /** Short description of the error */
    message: string
    /** Additional error data (optional) */
    data?: unknown
}

/**
 * Authenticated HTTP caller, when a provider accepted the request.
 */
export interface RpcCaller {
    provider?: string
    userId?: string
    /** OIDC issuer when the caller is an OIDC identity. */
    issuer?: string
}

/**
 * Context passed to method handlers
 */
export interface RpcContext {
    /** Cloudflare Worker environment bindings */
    env: unknown
    /** Original request (for headers, etc.) */
    request?: Request
    /** Set by the auth middleware after a provider succeeds. */
    auth?: RpcCaller
}

/**
 * Method handler function signature
 */
export type MethodHandler<TParams = unknown, TResult = unknown> = (
    params: TParams,
    ctx: RpcContext,
) => Promise<TResult>

/**
 * Registry of method handlers
 */
export type MethodRegistry = Record<string, MethodHandler>
