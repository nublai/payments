import {
    stubNamespace,
    queueBatch,
    type TestStubMethods,
} from './env'

export { queueBatch, stubNamespace }

/** Methods these tests actually call on a Durable Object namespace. */
export type NamespaceIdAndGet = {
    idFromName: (name: string) => string
    get: (id: string) => TestStubMethods
}

/** Tests only call idFromName/get on this Durable Object namespace. */
export function namespaceStub(stub: NamespaceIdAndGet) {
    return stubNamespace(stub)
}

export type QueueTestMessage = {
    body: {
        type: string
        txId: string
        txHash: string
        signerName: string
        chainId: number
        attempt: number
    } | null
    attempts: number
    ack: () => void
    retry: (options?: { delaySeconds?: number }) => void
}

/** Real Response for stubs that only read ok and json(). */
export function jsonStub<T>(body: T, ok = true): Response {
    return new Response(JSON.stringify(body), {
        status: ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
    })
}

export function signerPoolWithFetch(
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
    return namespaceStub({
        idFromName: () => 'pool-id',
        get: () => ({ fetch }),
    })
}
