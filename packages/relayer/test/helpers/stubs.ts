import type { Env } from '../../src/types/env'
import type { QueueJob } from '../../src/types/pool'

type EnvDurableObject =
    | Env['SIGNER']
    | Env['SIGNER_POOL']
    | Env['INTENT_NONCE_MANAGER']
    | NonNullable<Env['BUNDLE_STATUS_DO']>
    | NonNullable<Env['HTTP_AUTH_NONCE_MANAGER']>
    | NonNullable<Env['WALLET_BINDING']>

/** Methods these tests actually call on a Durable Object namespace. */
export type NamespaceIdAndGet = {
    idFromName: (name: string) => string
    get: (id: string) => {
        fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
        getBundlesByEoa?: (
            eoa: string,
            limit: number,
            offset: number,
        ) => Promise<{
            items: Array<{ bundleId: string; chainId: number; createdAt: number }>
            total: number
        }>
    }
}

/** Tests only call idFromName/get on this Durable Object namespace. */
export function namespaceStub<T extends EnvDurableObject>(stub: NamespaceIdAndGet): T {
    // SAFETY: T is an Env Durable Object namespace; tests only call idFromName/get.
    return stub as unknown as T
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

/** handleQueue only iterates messages and calls ack/retry on each. */
export function queueBatch(messages: QueueTestMessage[]): MessageBatch<QueueJob> {
    const batch = {
        queue: 'monitor',
        metadata: { messageCount: messages.length },
        messages: messages.map((message, index) => ({
            id: `test-message-${index}`,
            timestamp: new Date(0),
            body: message.body,
            attempts: message.attempts,
            ack: message.ack,
            retry: message.retry,
        })),
        ackAll() {},
        retryAll() {},
    }

    // SAFETY: handleQueue only reads messages and calls ack/retry; retired/null bodies are not MonitorJob.
    return batch as unknown as MessageBatch<QueueJob>
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
    return namespaceStub<Env['SIGNER_POOL']>({
        idFromName: () => 'pool-id',
        get: () => ({ fetch }),
    })
}
