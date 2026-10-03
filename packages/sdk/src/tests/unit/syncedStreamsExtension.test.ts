import { afterEach, describe, expect, test, vi } from 'vitest'
import { StubPersistenceStore } from '../../persistenceStore'
import { SyncedStreamsExtension } from '../../syncedStreamsExtension'
import type { SyncedStreamsControllerDelegate } from '../../sync/ISyncedStreamsController'
import type { ClientInitStatus } from '../../types'

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

describe('SyncedStreamsExtension', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    test('stop does not reschedule ticking after shutdown', async () => {
        vi.useFakeTimers()

        const loadStreams = createDeferred<{
            streams: Record<string, never>
            lastAccessedAt: Record<string, number>
        }>()
        const persistenceStore = new StubPersistenceStore()
        persistenceStore.loadStreams = vi.fn(async () => loadStreams.promise)

        const delegate: SyncedStreamsControllerDelegate = {
            startSyncStreams: vi.fn(async () => undefined),
            initStream: vi.fn(async () => {
                throw new Error('unused')
            }) as SyncedStreamsControllerDelegate['initStream'],
            emitClientInitStatus: vi.fn((_status: ClientInitStatus) => undefined),
        }

        const extension = new SyncedStreamsExtension([], delegate, persistenceStore, 'test')
        extension.setStreamIds([])
        extension.start()

        await vi.runOnlyPendingTimersAsync()

        const stopPromise = extension.stop()
        loadStreams.resolve({ streams: {}, lastAccessedAt: {} })
        await stopPromise
        await Promise.resolve()

        expect(vi.getTimerCount()).toBe(0)
    })
})
