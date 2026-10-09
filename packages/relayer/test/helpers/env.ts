import type { Env } from '../../src/types/env'
import type { QueueJob } from '../../src/types/pool'

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

const emptyQueueMetrics = { backlogCount: 0, backlogBytes: 0 }

function durableObjectId(value: string): DurableObjectId {
    return {
        toString: () => value,
        equals: (other) => other.toString() === value,
        name: value,
    }
}

/** Methods these tests actually call on a Durable Object stub. */
export type TestStubMethods = {
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

function durableObjectStub(methods: TestStubMethods = {}) {
    const id = durableObjectId('stub')

    return {
        id,
        name: id.name,
        fetch:
            methods.fetch ??
            (async () => {
                throw new Error('Durable Object fetch is not stubbed')
            }),
        connect(): Socket {
            throw new Error('Durable Object connect is not stubbed')
        },
        consumeNonce:
            methods.consumeNonce ??
            (async () => {
                throw new Error('Durable Object consumeNonce is not stubbed')
            }),
        getBundlesByEoa:
            methods.getBundlesByEoa ??
            (async () => {
                throw new Error('Durable Object getBundlesByEoa is not stubbed')
            }),
    }
}

/** Methods these tests actually call on a Durable Object namespace. */
export type TestBindingStub = {
    idFromName?: (name: string) => string
    get?: (id: string) => TestStubMethods
}

/** Minimal DurableObjectNamespace. Tests only call the methods they install. */
export function stubNamespace(stub: TestBindingStub = {}) {
    const namespace = {
        newUniqueId() {
            return durableObjectId('unique')
        },
        idFromName(name: string) {
            return durableObjectId(stub.idFromName?.(name) ?? name)
        },
        idFromString(id: string) {
            return durableObjectId(id)
        },
        get(id: DurableObjectId, _options?: DurableObjectNamespaceGetDurableObjectOptions) {
            return durableObjectStub(stub.get?.(id.toString()) ?? {})
        },
        getByName(name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) {
            return namespace.get(namespace.idFromName(name), options)
        },
        jurisdiction() {
            return namespace
        },
    }

    return namespace
}

/** Minimal Queue. Tests that install `send` use that implementation. */
export function queueBinding(
    handlers: { send?: (...args: Parameters<Queue['send']>) => void | Promise<void> } = {},
): Queue {
    const queue: Queue = {
        async metrics() {
            return emptyQueueMetrics
        },
        async send(message, options) {
            await handlers.send?.(message, options)

            return { metadata: { metrics: emptyQueueMetrics } }
        },
        async sendBatch() {
            return { metadata: { metrics: emptyQueueMetrics } }
        },
    }

    return queue
}

type TestNamespace = ReturnType<typeof stubNamespace>

type NamespaceOverride =
    | Env['SIGNER']
    | Env['SIGNER_POOL']
    | Env['INTENT_NONCE_MANAGER']
    | NonNullable<Env['BUNDLE_STATUS_DO']>
    | NonNullable<Env['HTTP_AUTH_NONCE_MANAGER']>
    | NonNullable<Env['WALLET_BINDING']>
    | TestNamespace

/** Env overrides that accept the typed DurableObjectNamespace/Queue fixtures. */
export type TestEnvOverrides = {
    [K in keyof Env]?: K extends
        | 'SIGNER'
        | 'SIGNER_POOL'
        | 'INTENT_NONCE_MANAGER'
        | 'BUNDLE_STATUS_DO'
        | 'HTTP_AUTH_NONCE_MANAGER'
        | 'WALLET_BINDING'
        ? Env[K] | NamespaceOverride
        : K extends 'MONITOR_QUEUE'
          ? Env[K] | Queue
          : Env[K]
}

/** Minimal Env with unused DO/queue bindings. Override any field the test needs. */
export function testEnv(overrides: TestEnvOverrides = {}): Env {
    const env: Env = {
        SIGNER: unusedBinding<Env['SIGNER']>(),
        SIGNER_POOL: unusedBinding<Env['SIGNER_POOL']>(),
        INTENT_NONCE_MANAGER: unusedBinding<Env['INTENT_NONCE_MANAGER']>(),
        MONITOR_QUEUE: unusedBinding<Env['MONITOR_QUEUE']>(),
        RELAYER_MNEMONIC: DEFAULT_MNEMONIC,
    }

    Object.assign(env, overrides)

    return env
}

type CloudflareTestBindings = typeof import('cloudflare:test').env

/** The vitest-pool-workers `env` is the worker Env; ProvidedEnv is empty in the type. */
export function workerEnv(env: CloudflareTestBindings): Env {
    // SAFETY: the Cloudflare test pool injects the real worker Env bindings at runtime.
    return env as Env
}

export type TestQueueMessage = {
    body: QueueJob | { type?: string; bundleId?: string; attempt?: number } | null
    attempts?: number
    ack: () => void
    retry: (options?: { delaySeconds?: number }) => void
}

function queueJobBody(body: TestQueueMessage['body']): QueueJob {
    if (
        body !== null &&
        'txId' in body &&
        'txHash' in body &&
        'signerName' in body &&
        'chainId' in body &&
        'attempt' in body
    ) {
        return body
    }

    // SAFETY: handleQueue only reads body/attempts/ack/retry; retired/null bodies are not MonitorJob.
    return body as QueueJob
}

/** Queue batch that implements the MessageBatch fields handleQueue reads. */
export function queueBatch(messages: TestQueueMessage[]): MessageBatch<QueueJob> {
    const batch: MessageBatch<QueueJob> = {
        queue: 'monitor',
        metadata: {
            metrics: {
                backlogCount: messages.length,
                backlogBytes: 0,
            },
        },
        messages: messages.map((message, index) => ({
            id: `test-message-${index}`,
            timestamp: new Date(0),
            body: queueJobBody(message.body),
            attempts: message.attempts ?? 0,
            ack: message.ack,
            retry: message.retry,
        })),
        ackAll() {},
        retryAll() {},
    }

    return batch
}
