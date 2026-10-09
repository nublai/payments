import type { BundleStatusDO } from '../../src/durable-objects/bundle-status.do'
import type { HttpAuthNonceDO } from '../../src/durable-objects/http-auth-nonce.do'
import type { IntentNonceDO } from '../../src/durable-objects/intent-nonce.do'
import type { SignerDO } from '../../src/durable-objects/signer.do'
import type { SignerPoolDO } from '../../src/durable-objects/signer-pool.do'
import type { WalletBindingDO } from '../../src/durable-objects/wallet-binding.do'
import type { Env } from '../../src/types/env'

const DEFAULT_MNEMONIC = 'test test test test test test test test test test test junk'

const emptyQueueMetrics = { backlogCount: 0, backlogBytes: 0 }

function unused(name: string): never {
    throw new Error(`${name} is not stubbed`)
}

function durableObjectId(value: string): DurableObjectId {
    return {
        toString: () => value,
        equals: (other) => other.toString() === value,
        name: value,
    }
}

export type BundleHistoryRow = {
    bundleId: string
    chainId: number
    createdAt: number
}

type BundlesByEoa = DurableObjectStub<BundleStatusDO>['getBundlesByEoa']

type BundlesByEoaResult = ReturnType<BundlesByEoa>

type ConsumeNonce = DurableObjectStub<HttpAuthNonceDO>['consumeNonce']

type PipelinedBundleRow = Promise<BundleHistoryRow & Disposable> & {
    bundleId: Promise<string>
    chainId: Promise<number>
    createdAt: Promise<number>
}

function disposableRows(rows: BundleHistoryRow[]): BundleHistoryRow[] & Disposable {
    return Object.assign(rows.slice(), {
        [Symbol.dispose]() {},
    })
}

function pipelinedRow(row: BundleHistoryRow): PipelinedBundleRow {
    return Object.assign(
        Promise.resolve({
            ...row,
            [Symbol.dispose]() {},
        }),
        {
            bundleId: Promise.resolve(row.bundleId),
            chainId: Promise.resolve(row.chainId),
            createdAt: Promise.resolve(row.createdAt),
        },
    )
}

function bundlesItems(rows: BundleHistoryRow[]): BundlesByEoaResult['items'] {
    const settled = Promise.resolve(disposableRows(rows))

    return Object.assign(rows.map(pipelinedRow), settled, {
        [Promise.prototype.then.name]: settled.then.bind(settled),
        catch: settled.catch.bind(settled),
        finally: settled.finally.bind(settled),
        [Symbol.toStringTag]: 'Promise',
    })
}

/** RPC Result for BundleStatusDO.getBundlesByEoa: Promise & Disposable & items/total pipelining. */
export function bundlesByEoaResult(
    items: BundleHistoryRow[],
    total: number,
): BundlesByEoaResult {
    return Object.assign(
        Promise.resolve({
            items,
            total,
            [Symbol.dispose]() {},
        }),
        {
            items: bundlesItems(items),
            total: Promise.resolve(total),
        },
    )
}

export function pendingBundlesByEoa() {
    let settle: (value: { items: BundleHistoryRow[]; total: number } & Disposable) => void =
        () => {
            unused('pendingBundlesByEoa.settle')
        }

    const settled = new Promise<{ items: BundleHistoryRow[]; total: number } & Disposable>(
        (resolve) => {
            settle = resolve
        },
    )

    return {
        result: Object.assign(settled, {
            items: bundlesItems([]),
            total: settled.then((value) => value.total),
        }),
        resolve(items: BundleHistoryRow[], total: number) {
            settle({
                items,
                total,
                [Symbol.dispose]() {},
            })
        },
    }
}

export type TestStubMethods = {
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    consumeNonce?: ConsumeNonce
    getBundlesByEoa?: BundlesByEoa
}

export type TestBindingStub = {
    idFromName?: (name: string) => string
    get?: (id: string) => TestStubMethods
}

function fetcherFields(id: DurableObjectId, fetchImpl?: TestStubMethods['fetch']) {
    return {
        id,
        name: id.name,
        fetch: fetchImpl ?? (async () => unused('fetch')),
        connect(): Socket {
            return unused('connect')
        },
    }
}

function signerStub(methods: TestStubMethods = {}): DurableObjectStub<SignerDO> {
    return {
        ...fetcherFields(durableObjectId('stub'), methods.fetch),
        get __DURABLE_OBJECT_BRAND(): never {
            return unused('brand')
        },
        getTxStatus: () => unused('getTxStatus'),
        getCapacity: () => unused('getCapacity'),
        sendTransaction: () => unused('sendTransaction'),
        handleFinalized: () => unused('handleFinalized'),
        handleMaintenance: () => unused('handleMaintenance'),
        getStatus: () => unused('getStatus'),
    }
}

function signerPoolStub(methods: TestStubMethods = {}): DurableObjectStub<SignerPoolDO> {
    return {
        ...fetcherFields(durableObjectId('stub'), methods.fetch),
        get __DURABLE_OBJECT_BRAND(): never {
            return unused('brand')
        },
        sendTransaction: () => unused('sendTransaction'),
        getPoolStatus: () => unused('getPoolStatus'),
        handleMaintenance: () => unused('handleMaintenance'),
    }
}

function intentNonceStub(methods: TestStubMethods = {}): DurableObjectStub<IntentNonceDO> {
    return {
        ...fetcherFields(durableObjectId('stub'), methods.fetch),
        get __DURABLE_OBJECT_BRAND(): never {
            return unused('brand')
        },
    }
}

function bundleStatusStub(methods: TestStubMethods = {}): DurableObjectStub<BundleStatusDO> {
    return {
        ...fetcherFields(durableObjectId('stub'), methods.fetch),
        get __DURABLE_OBJECT_BRAND(): never {
            return unused('brand')
        },
        getBundleIdByTxId: () => unused('getBundleIdByTxId'),
        upsertBundleTelemetry: () => unused('upsertBundleTelemetry'),
        getBundleTelemetry: () => unused('getBundleTelemetry'),
        getBundlesByEoa: methods.getBundlesByEoa ?? (() => unused('getBundlesByEoa')),
        add_bundle_tx: () => unused('add_bundle_tx'),
        get_bundle_status: () => unused('get_bundle_status'),
    }
}

function httpAuthNonceStub(methods: TestStubMethods = {}): DurableObjectStub<HttpAuthNonceDO> {
    return {
        ...fetcherFields(durableObjectId('stub'), methods.fetch),
        get __DURABLE_OBJECT_BRAND(): never {
            return unused('brand')
        },
        consumeNonce: methods.consumeNonce ?? (() => unused('consumeNonce')),
    }
}

function walletBindingStub(methods: TestStubMethods = {}): DurableObjectStub<WalletBindingDO> {
    return {
        ...fetcherFields(durableObjectId('stub'), methods.fetch),
        get __DURABLE_OBJECT_BRAND(): never {
            return unused('brand')
        },
        issueNonce: () => unused('issueNonce'),
        bind: () => unused('bind'),
        chargeBind: () => unused('chargeBind'),
        accountsFor: () => unused('accountsFor'),
        ownerOf: () => unused('ownerOf'),
    }
}

function namespaceOf<Stub>(
    makeStub: (methods: TestStubMethods) => Stub,
    stub: TestBindingStub = {},
) {
    const namespace = {
        newUniqueId() {
            return durableObjectId('unique')
        },
        idFromName(name: string) {
            return durableObjectId(stub.idFromName?.(name) ?? name)
        },
        idFromString(value: string) {
            return durableObjectId(value)
        },
        get(id: DurableObjectId, _options?: DurableObjectNamespaceGetDurableObjectOptions) {
            return makeStub(stub.get?.(id.toString()) ?? {})
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

export function signerNamespace(stub: TestBindingStub = {}): Env['SIGNER'] {
    return namespaceOf(signerStub, stub)
}

export function signerPoolNamespace(stub: TestBindingStub = {}): Env['SIGNER_POOL'] {
    return namespaceOf(signerPoolStub, stub)
}

export function intentNonceNamespace(stub: TestBindingStub = {}): Env['INTENT_NONCE_MANAGER'] {
    return namespaceOf(intentNonceStub, stub)
}

export function bundleStatusNamespace(
    stub: TestBindingStub = {},
): NonNullable<Env['BUNDLE_STATUS_DO']> {
    return namespaceOf(bundleStatusStub, stub)
}

export function httpAuthNonceNamespace(
    stub: TestBindingStub = {},
): NonNullable<Env['HTTP_AUTH_NONCE_MANAGER']> {
    return namespaceOf(httpAuthNonceStub, stub)
}

export function walletBindingNamespace(
    stub: TestBindingStub = {},
): NonNullable<Env['WALLET_BINDING']> {
    return namespaceOf(walletBindingStub, stub)
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

/** Minimal Env with unused DO/queue bindings. Override any field the test needs. */
export function testEnv(overrides: Partial<Env> = {}): Env {
    return {
        SIGNER: signerNamespace(),
        SIGNER_POOL: signerPoolNamespace(),
        INTENT_NONCE_MANAGER: intentNonceNamespace(),
        MONITOR_QUEUE: queueBinding(),
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

export type QueueMessageFields<T> = {
    body: T
    attempts?: number
    ack: () => void
    retry: (options?: { delaySeconds?: number }) => void
}

/** Queue batch that implements the MessageBatch fields handleQueue reads. */
export function queueBatch<T>(messages: QueueMessageFields<T>[]): MessageBatch<T> {
    const batch: MessageBatch<T> = {
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
            body: message.body,
            attempts: message.attempts ?? 0,
            ack: message.ack,
            retry: message.retry,
        })),
        ackAll() {},
        retryAll() {},
    }

    return batch
}

export function durableObjectState(sql: SqlStorage): DurableObjectState {
    const storage: DurableObjectStorage = {
        get: () => unused('storage.get'),
        list: () => unused('storage.list'),
        put: () => unused('storage.put'),
        delete: () => unused('storage.delete'),
        deleteAll: () => unused('storage.deleteAll'),
        transaction: () => unused('storage.transaction'),
        getAlarm: () => unused('storage.getAlarm'),
        setAlarm: () => unused('storage.setAlarm'),
        deleteAlarm: () => unused('storage.deleteAlarm'),
        sync: () => unused('storage.sync'),
        sql,
        kv: {
            get: () => unused('kv.get'),
            list: () => unused('kv.list'),
            put: () => unused('kv.put'),
            delete: () => unused('kv.delete'),
        },
        transactionSync<T>(fn: () => T) {
            return fn()
        },
        getCurrentBookmark: () => unused('storage.getCurrentBookmark'),
        getBookmarkForTime: () => unused('storage.getBookmarkForTime'),
        onNextSessionRestoreBookmark: () => unused('storage.onNextSessionRestoreBookmark'),
    }

    return {
        waitUntil() {},
        props: {},
        id: durableObjectId('intent-nonce'),
        storage,
        facets: {
            get: () => unused('facets.get'),
            abort: () => unused('facets.abort'),
            delete: () => unused('facets.delete'),
            clone: () => unused('facets.clone'),
        },
        blockConcurrencyWhile: () => unused('blockConcurrencyWhile'),
        acceptWebSocket: () => unused('acceptWebSocket'),
        getWebSockets: () => unused('getWebSockets'),
        setWebSocketAutoResponse: () => unused('setWebSocketAutoResponse'),
        getWebSocketAutoResponse: () => unused('getWebSocketAutoResponse'),
        getWebSocketAutoResponseTimestamp: () => unused('getWebSocketAutoResponseTimestamp'),
        setHibernatableWebSocketEventTimeout: () => unused('setHibernatableWebSocketEventTimeout'),
        getHibernatableWebSocketEventTimeout: () => unused('getHibernatableWebSocketEventTimeout'),
        getTags: () => unused('getTags'),
        abort: () => unused('abort'),
    }
}
