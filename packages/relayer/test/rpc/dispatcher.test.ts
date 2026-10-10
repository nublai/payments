/**
 * Unit tests for JSON-RPC 2.0 dispatcher
 */

import { describe, it, expect, vi } from 'vitest'
import { dispatch } from '../../src/rpc/dispatcher'
import type { JsonRpcParams, MethodRegistry, RpcContext } from '../../src/rpc/types'
import { requireJsonRpcBatch } from '../helpers/rpc'
import {
    PARSE_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    INTERNAL_ERROR,
    RpcError,
} from '../../src/rpc/errors'

// Mock context for tests
const mockCtx: RpcContext = {
    env: {},
}

// Test method handlers
const echoHandler = vi.fn(async (params: JsonRpcParams | undefined) => params)

const errorHandler = vi.fn(async () => {
    throw new RpcError(-32000, 'Test error', { detail: 'test' })
})

const throwHandler = vi.fn(async () => {
    throw new Error('Unexpected error')
})

describe('JSON-RPC Dispatcher', () => {
    describe('single requests', () => {
        it('should route to correct method handler', async () => {
            const methods: MethodRegistry = {
                test_echo: echoHandler,
            }

            const request = {
                jsonrpc: '2.0' as const,
                id: 1,
                method: 'test_echo',
                params: [{ message: 'hello' }],
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(echoHandler).toHaveBeenCalledWith([{ message: 'hello' }], mockCtx)
            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 1,
                result: [{ message: 'hello' }],
            })
        })

        it('should return result on success', async () => {
            const methods: MethodRegistry = {
                test_add: async (params: JsonRpcParams | undefined) => {
                    if (!Array.isArray(params) || params.length !== 2) {
                        throw new Error('expected two numeric params')
                    }

                    const [a, b] = params

                    return Number(a) + Number(b)
                },
            }

            const request = {
                jsonrpc: '2.0' as const,
                id: 'abc',
                method: 'test_add',
                params: [2, 3],
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 'abc',
                result: 5,
            })
        })

        it('should return error for unknown method', async () => {
            const methods: MethodRegistry = {}

            const request = {
                jsonrpc: '2.0' as const,
                id: 1,
                method: 'unknown_method',
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 1,
                error: {
                    code: METHOD_NOT_FOUND,
                    message: 'Method not found: unknown_method',
                },
            })
        })

        it('should return parse error for invalid JSON', async () => {
            const methods: MethodRegistry = {}

            // Simulate invalid JSON by passing a string that's not valid JSON-RPC
            const response = await dispatch('not json', methods, mockCtx)

            expect(response).toEqual({
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: PARSE_ERROR,
                    message: 'Parse error',
                },
            })
        })

        it('should return invalid request for missing jsonrpc field', async () => {
            const methods: MethodRegistry = {}

            const request = {
                id: 1,
                method: 'test',
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 1,
                error: {
                    code: INVALID_REQUEST,
                    message: 'Invalid Request',
                },
            })
        })

        it('should return invalid request for wrong jsonrpc version', async () => {
            const methods: MethodRegistry = {}

            const request = {
                jsonrpc: '1.0',
                id: 1,
                method: 'test',
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 1,
                error: {
                    code: INVALID_REQUEST,
                    message: 'Invalid Request',
                },
            })
        })

        it('should return invalid request for missing method', async () => {
            const methods: MethodRegistry = {}

            const request = {
                jsonrpc: '2.0',
                id: 1,
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 1,
                error: {
                    code: INVALID_REQUEST,
                    message: 'Invalid Request',
                },
            })
        })

        it('should handle RpcError from handler', async () => {
            const methods: MethodRegistry = {
                test_error: errorHandler,
            }

            const request = {
                jsonrpc: '2.0' as const,
                id: 1,
                method: 'test_error',
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 1,
                error: {
                    code: -32000,
                    message: 'Test error',
                    data: { detail: 'test' },
                },
            })
        })

        it('should handle unexpected errors as internal error', async () => {
            const methods: MethodRegistry = {
                test_throw: throwHandler,
            }

            const request = {
                jsonrpc: '2.0' as const,
                id: 1,
                method: 'test_throw',
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 1,
                error: {
                    code: INTERNAL_ERROR,
                    message: 'Internal error',
                },
            })
        })

        it('should handle request with no params', async () => {
            const noParamsHandler = vi.fn(async () => 'no params')

            const methods: MethodRegistry = {
                test_noparams: noParamsHandler,
            }

            const request = {
                jsonrpc: '2.0' as const,
                id: 1,
                method: 'test_noparams',
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(noParamsHandler).toHaveBeenCalledWith(undefined, mockCtx)
            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 1,
                result: 'no params',
            })
        })

        it('should handle request with object params (named)', async () => {
            const namedHandler = vi.fn(async (params: JsonRpcParams | undefined) => params)

            const methods: MethodRegistry = {
                test_named: namedHandler,
            }

            const request = {
                jsonrpc: '2.0' as const,
                id: 1,
                method: 'test_named',
                params: { name: 'Alice', age: 30 },
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(namedHandler).toHaveBeenCalledWith({ name: 'Alice', age: 30 }, mockCtx)
            expect(response).toEqual({
                jsonrpc: '2.0',
                id: 1,
                result: { name: 'Alice', age: 30 },
            })
        })
    })

    describe('batch requests', () => {
        it('should process array of requests', async () => {
            const methods: MethodRegistry = {
                test_echo: async (params: JsonRpcParams | undefined) => params,
            }

            const requests = [
                { jsonrpc: '2.0' as const, id: 1, method: 'test_echo', params: ['a'] },
                { jsonrpc: '2.0' as const, id: 2, method: 'test_echo', params: ['b'] },
            ]

            const response = await dispatch(requests, methods, mockCtx)

            expect(Array.isArray(response)).toBe(true)
            expect(response).toHaveLength(2)
        })

        it('should return array of responses in same order', async () => {
            const methods: MethodRegistry = {
                test_echo: async (params: JsonRpcParams | undefined) => params,
            }

            const requests = [
                { jsonrpc: '2.0' as const, id: 1, method: 'test_echo', params: ['first'] },
                { jsonrpc: '2.0' as const, id: 2, method: 'test_echo', params: ['second'] },
                { jsonrpc: '2.0' as const, id: 3, method: 'test_echo', params: ['third'] },
            ]

            const response = requireJsonRpcBatch(await dispatch(requests, methods, mockCtx))

            expect(response[0].id).toBe(1)
            expect(response[0].result).toEqual(['first'])
            expect(response[1].id).toBe(2)
            expect(response[1].result).toEqual(['second'])
            expect(response[2].id).toBe(3)
            expect(response[2].result).toEqual(['third'])
        })

        it('should handle mixed success/error in batch', async () => {
            const methods: MethodRegistry = {
                test_echo: async (params: JsonRpcParams | undefined) => params,
                test_error: async () => {
                    throw new RpcError(-32000, 'Error')
                },
            }

            const requests = [
                { jsonrpc: '2.0' as const, id: 1, method: 'test_echo', params: ['ok'] },
                { jsonrpc: '2.0' as const, id: 2, method: 'test_error' },
                { jsonrpc: '2.0' as const, id: 3, method: 'unknown' },
            ]

            const response = requireJsonRpcBatch(await dispatch(requests, methods, mockCtx))

            expect(response[0].result).toEqual(['ok'])
            expect(response[1].error?.code).toBe(-32000)
            expect(response[2].error?.code).toBe(METHOD_NOT_FOUND)
        })

        it('should return invalid request for empty array', async () => {
            const methods: MethodRegistry = {}

            const response = await dispatch([], methods, mockCtx)

            expect(response).toEqual({
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: INVALID_REQUEST,
                    message: 'Invalid Request',
                },
            })
        })
    })

    describe('notifications (id: null)', () => {
        it('should process but not return response for notification', async () => {
            const handler = vi.fn(async () => 'result')

            const methods: MethodRegistry = {
                test_notify: handler,
            }

            const request = {
                jsonrpc: '2.0' as const,
                id: null,
                method: 'test_notify',
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(handler).toHaveBeenCalled()
            expect(response).toBeNull()
        })

        it('should not return response for notification even on error', async () => {
            const handler = vi.fn(async () => {
                throw new Error('Notification error')
            })

            const methods: MethodRegistry = {
                test_notify: handler,
            }

            const request = {
                jsonrpc: '2.0' as const,
                id: null,
                method: 'test_notify',
            }

            const response = await dispatch(request, methods, mockCtx)

            expect(handler).toHaveBeenCalled()
            expect(response).toBeNull()
        })

        it('should filter out notifications from batch response', async () => {
            const methods: MethodRegistry = {
                test_echo: async (params: JsonRpcParams | undefined) => params,
            }

            const requests = [
                { jsonrpc: '2.0' as const, id: 1, method: 'test_echo', params: ['with-id'] },
                {
                    jsonrpc: '2.0' as const,
                    id: null,
                    method: 'test_echo',
                    params: ['notification'],
                },
                { jsonrpc: '2.0' as const, id: 2, method: 'test_echo', params: ['also-with-id'] },
            ]

            const response = requireJsonRpcBatch(await dispatch(requests, methods, mockCtx))

            // Should only return 2 responses (not the notification)
            expect(response).toHaveLength(2)
            expect(response[0].id).toBe(1)
            expect(response[1].id).toBe(2)
        })
    })
})
