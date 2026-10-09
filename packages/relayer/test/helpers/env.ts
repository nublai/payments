import type { Env } from '../../src/types/env'

type EnvBinding =
    | Env['SIGNER']
    | Env['SIGNER_POOL']
    | Env['INTENT_NONCE_MANAGER']
    | Env['MONITOR_QUEUE']
    | NonNullable<Env['BUNDLE_STATUS_DO']>
    | NonNullable<Env['HTTP_AUTH_NONCE_MANAGER']>
    | NonNullable<Env['WALLET_BINDING']>

/** Empty Durable Object / Queue binding. Unit tests that build Env never call these. */
export function unusedBinding<T extends EnvBinding>(): T {
    // SAFETY: these tests never invoke this binding; the empty object only fills Env's required key.
    return {} as T
}

const DEFAULT_MNEMONIC = 'test test test test test test test test test test test junk'

/** Minimal Env with unused DO/queue bindings. Override any field the test needs. */
export function testEnv(overrides: Partial<Env> = {}): Env {
    return {
        SIGNER: unusedBinding<Env['SIGNER']>(),
        SIGNER_POOL: unusedBinding<Env['SIGNER_POOL']>(),
        INTENT_NONCE_MANAGER: unusedBinding<Env['INTENT_NONCE_MANAGER']>(),
        MONITOR_QUEUE: unusedBinding<Env['MONITOR_QUEUE']>(),
        RELAYER_MNEMONIC: DEFAULT_MNEMONIC,
        ...overrides,
    }
}

type CloudflareTestBindings = typeof import('cloudflare:test').env

/** The vitest-pool-workers `env` is the worker Env; ProvidedEnv is empty in the type. */
export function workerEnv(env: CloudflareTestBindings): Env {
    // SAFETY: the Cloudflare test pool injects the real worker Env bindings at runtime.
    return env as Env
}

/** Methods these tests actually call on a Durable Object namespace or Queue. */
export type TestBindingStub = {
    idFromName?: (name: string) => string
    get?: (id: string) => {
        fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
        consumeNonce?: (replayKey: string, ttlSeconds: number) => Promise<boolean>
        getBundlesByEoa?: (
            eoa: string,
            limit: number,
            offset: number,
        ) => Promise<{
            items: Array<{ bundleId: string; chainId: number; createdAt: number }>
            total: number
        }>
    }
    send?: () => void | Promise<void>
}

/** Namespace or queue stub that only implements the methods a test calls. */
export function stubNamespace<T extends EnvBinding>(stub: TestBindingStub): T {
    // SAFETY: T is an Env DO/queue binding; tests only call the methods they install on this stub.
    return stub as TestBindingStub & T
}

export type TestQueueMessage = {
    body: { type?: string; bundleId?: string; attempt?: number }
    attempts?: number
    ack: () => void
    retry: (options?: { delaySeconds?: number }) => void
}

/** Queue batch that only implements the messages/ack/retry fields handleQueue reads. */
export function queueBatch(messages: TestQueueMessage[]): MessageBatch<import('../../src/types/pool').QueueJob> {
    const batch = {
        queue: 'monitor',
        metadata: { messageCount: messages.length },
        messages: messages.map((message, index) => ({
            id: `test-message-${index}`,
            timestamp: new Date(0),
            body: message.body,
            attempts: message.attempts ?? 0,
            ack: message.ack,
            retry: message.retry,
        })),
        ackAll() {},
        retryAll() {},
    }

    // SAFETY: handleQueue only reads messages[].body/attempts/ack/retry; retired fulfillment bodies are not MonitorJob.
    return batch as typeof batch & MessageBatch<import('../../src/types/pool').QueueJob>
}
