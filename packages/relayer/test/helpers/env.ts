import type { Env } from '../../src/types/env'

/** Empty Durable Object / Queue binding. Unit tests that build Env never call these. */
export function unusedBinding<T>(): T {
    // SAFETY: these tests never invoke this binding; the empty object only fills Env's required key.
    return {} as T
}

const DEFAULT_MNEMONIC = 'test test test test test test test test test test junk'

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

/** Namespace or queue stub that only implements the methods a test calls. */
export function stubNamespace<T>(stub: Partial<T>): T {
    // SAFETY: these tests only call the methods they install on this stub.
    return stub as T
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
    return batch as MessageBatch<import('../../src/types/pool').QueueJob>
}
