import { RpcError } from '../../src/rpc/errors'
import type { JsonRpcResponse } from '../../src/rpc/types'

/** Narrow a validate/send error-branch result after the test already asserted RpcError. */
export function requireRpcError(error: Error): RpcError {
    if (error instanceof RpcError) return error

    throw new Error('expected RpcError on this error-branch test')
}

/** Narrow a dispatcher batch after the test already asserted an array response. */
export function requireJsonRpcBatch(
    response: JsonRpcResponse | JsonRpcResponse[] | null,
): JsonRpcResponse[] {
    if (Array.isArray(response)) return response

    throw new Error('expected a JSON-RPC batch response')
}

/** JSON the test just built or the handler just returned. */
export function parseJson<T>(text: string): T {
    // SAFETY: callers only parse JSON they constructed or the handler under test just returned.
    return JSON.parse(text) as T
}

export type JsonStubBody = JsonRpcResponse | { signerCount: number }

/** Fetch/DO stub that only uses ok and json(). */
export function jsonResponse(body: JsonStubBody, ok = true): Response {
    return new Response(JSON.stringify(body), {
        status: ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
    })
}
