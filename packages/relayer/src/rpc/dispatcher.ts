/**
 * JSON-RPC 2.0 Dispatcher
 *
 * Routes incoming JSON-RPC requests to the appropriate method handlers.
 * Supports single requests, batch requests, and notifications.
 */

import type {
    JsonRpcRequest,
    JsonRpcResponse,
    JsonRpcErrorObject,
    MethodRegistry,
    RpcContext,
} from './types'
import {
    PARSE_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    INTERNAL_ERROR,
    RpcError,
    ERROR_MESSAGES,
} from './errors'
import { canOptimizeBatch, handleBatchSendPreparedCalls } from './methods/sendPreparedCalls'

/**
 * Dispatch a JSON-RPC request (or batch of requests) to the appropriate handler(s)
 *
 * @param body - The parsed JSON body (single request or array of requests)
 * @param methods - Registry of method handlers
 * @param ctx - Request context (env, request, etc.)
 * @returns Response(s) or null for notifications
 */
export async function dispatch(
    body: unknown,
    methods: MethodRegistry,
    ctx: RpcContext,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    // Handle non-object input (parse error)
    if (typeof body !== 'object' || body === null) {
        return createErrorResponse(null, PARSE_ERROR, ERROR_MESSAGES[PARSE_ERROR])
    }

    // Handle batch requests
    if (Array.isArray(body)) {
        return handleBatch(body, methods, ctx)
    }

    // Handle single request
    return handleSingle(body, methods, ctx)
}

/**
 * Handle a single JSON-RPC request
 */
async function handleSingle(
    body: unknown,
    methods: MethodRegistry,
    ctx: RpcContext,
): Promise<JsonRpcResponse | null> {
    // Extract id for error responses (may be undefined)
    const id = extractId(body)

    // Validate request structure
    const validationError = validateRequest(body)

    if (validationError) {
        // Notifications don't get error responses
        if (id === null) return null

        return createErrorResponse(id, validationError.code, validationError.message)
    }

    const request = body as JsonRpcRequest
    const isNotification = request.id === null

    // Look up method handler
    const handler = methods[request.method]

    if (!handler) {
        if (isNotification) return null

        return createErrorResponse(
            request.id,
            METHOD_NOT_FOUND,
            `Method not found: ${request.method}`,
        )
    }

    // Execute handler
    try {
        const result = await handler(request.params, ctx)

        // Notifications don't get responses
        if (isNotification) return null

        return createSuccessResponse(request.id, result)
    } catch (error) {
        // Notifications don't get error responses
        if (isNotification) return null

        if (error instanceof RpcError) {
            return createErrorResponse(request.id, error.code, error.message, error.data)
        }

        // Unexpected errors become internal errors
        return createErrorResponse(request.id, INTERNAL_ERROR, ERROR_MESSAGES[INTERNAL_ERROR])
    }
}

/**
 * Handle a batch of JSON-RPC requests
 */
async function handleBatch(
    requests: unknown[],
    methods: MethodRegistry,
    ctx: RpcContext,
): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    // Empty batch is invalid
    if (requests.length === 0) {
        return createErrorResponse(null, INVALID_REQUEST, ERROR_MESSAGES[INVALID_REQUEST])
    }

    // Check if this batch can be optimized (all wallet_sendPreparedCalls)
    const parsedRequests: {
        id: string | number | null
        method: string
        params: unknown
    }[] = []

    for (const req of requests) {
        if (typeof req !== 'object' || req === null) continue

        // SAFETY: req is a non-null object; only id/method/params are read, matching JSON-RPC request keys.
        const obj = req as { id?: unknown; method?: unknown; params?: unknown }

        parsedRequests.push({
            id: obj.id as string | number | null,
            method: obj.method as string,
            params: obj.params,
        })
    }

    if (canOptimizeBatch(parsedRequests)) {
        // Use batch optimization - combine into single execute(bytes[])
        const batchResults = await handleBatchSendPreparedCalls(
            parsedRequests.map((r) => ({ id: r.id, params: r.params })),
            ctx,
        )

        // Convert to JSON-RPC responses
        return batchResults.map((r) => {
            if (r.error) {
                if (r.error instanceof RpcError) {
                    return createErrorResponse(r.id, r.error.code, r.error.message, r.error.data)
                }

                return createErrorResponse(r.id, INTERNAL_ERROR, ERROR_MESSAGES[INTERNAL_ERROR])
            }

            return createSuccessResponse(r.id, r.result)
        })
    }

    // Process all requests in parallel (default behavior)
    const results = await Promise.all(requests.map((req) => handleSingle(req, methods, ctx)))

    // Filter out null responses (notifications)
    const responses = results.filter((r): r is JsonRpcResponse => r !== null)

    // If all were notifications, return empty array? Per spec, server MUST NOT return empty array
    // So if all responses are notifications, we return nothing (but this is handled by the caller)
    // For now, return the filtered array which may be empty
    return responses
}

/**
 * Validate a JSON-RPC request object
 * Returns an error object if invalid, null if valid
 */
function validateRequest(body: unknown): JsonRpcErrorObject | null {
    if (typeof body !== 'object' || body === null) {
        return { code: INVALID_REQUEST, message: ERROR_MESSAGES[INVALID_REQUEST] }
    }

    // SAFETY: body is a non-null object; only the JSON-RPC request keys are read.
    const obj = body as { jsonrpc?: unknown; method?: unknown; id?: unknown; params?: unknown }

    // Must have jsonrpc: "2.0"
    if (obj.jsonrpc !== '2.0') {
        return { code: INVALID_REQUEST, message: ERROR_MESSAGES[INVALID_REQUEST] }
    }

    // Must have method as string
    if (typeof obj.method !== 'string') {
        return { code: INVALID_REQUEST, message: ERROR_MESSAGES[INVALID_REQUEST] }
    }

    // id can be string, number, or null (for notifications)
    // If present and not one of these types, it's invalid
    if (
        obj.id !== undefined &&
        obj.id !== null &&
        typeof obj.id !== 'string' &&
        typeof obj.id !== 'number'
    ) {
        return { code: INVALID_REQUEST, message: ERROR_MESSAGES[INVALID_REQUEST] }
    }

    // params, if present, must be array or object
    if (
        obj.params !== undefined &&
        typeof obj.params !== 'object' // arrays and objects are both "object"
    ) {
        return { code: INVALID_REQUEST, message: ERROR_MESSAGES[INVALID_REQUEST] }
    }

    return null
}

/**
 * Extract id from a potential request object
 * Returns the id if present (including null), or null if not extractable
 */
function extractId(body: unknown): string | number | null {
    if (typeof body !== 'object' || body === null) return null

    // SAFETY: body is a non-null object; only id is read.
    const obj = body as { id?: unknown }

    if (obj.id === undefined) return null

    if (obj.id === null || typeof obj.id === 'string' || typeof obj.id === 'number') {
        return obj.id
    }

    return null
}

/**
 * Create a success response
 */
function createSuccessResponse(id: string | number | null, result: unknown): JsonRpcResponse {
    return {
        jsonrpc: '2.0',
        id,
        result,
    }
}

/**
 * Create an error response
 */
function createErrorResponse(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
): JsonRpcResponse {
    const error: JsonRpcErrorObject = { code, message }

    if (data !== undefined) {
        error.data = data
    }

    return {
        jsonrpc: '2.0',
        id,
        error,
    }
}
