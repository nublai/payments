import type { Env } from '../../src/types/env'
import { signerPoolNamespace, type TestStubMethods } from './env'

export {
    queueBatch,
    signerNamespace,
    signerPoolNamespace,
    intentNonceNamespace,
    bundleStatusNamespace,
    httpAuthNonceNamespace,
    walletBindingNamespace,
} from './env'

/** Methods these tests actually call on a Durable Object namespace. */
export type NamespaceIdAndGet = {
    idFromName: (name: string) => string
    get: (id: string) => TestStubMethods
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
): Env['SIGNER_POOL'] {
    return signerPoolNamespace({
        idFromName: () => 'pool-id',
        get: () => ({ fetch }),
    })
}
