interface JsonRpcResponse<T> {
    result?: T
    error?: unknown
}

/**
 * Execute a JSON-RPC request against a chain RPC endpoint.
 * Throws on transport or JSON-RPC errors.
 */
export async function jsonRpcRequest<T>(
    rpcUrl: string,
    method: string,
    params: unknown[] = [],
    options?: { timeoutMs?: number },
): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 10_000)

    try {
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method,
                params,
            }),
            signal: controller.signal,
        })

        if (!response.ok) {
            throw new Error(`RPC not reachable: ${response.status} ${response.statusText}`)
        }

        const payload = (await response.json()) as JsonRpcResponse<T>

        if (payload.error) {
            throw new Error(`RPC method failed: ${method}`)
        }

        if (payload.result === undefined) {
            throw new Error(`RPC returned no result: ${method}`)
        }

        return payload.result
    } finally {
        clearTimeout(timeout)
    }
}
