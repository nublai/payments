/**
 * @group main
 */

import { KVCacheStorage, KVNamespace } from '../src/cache/KVCacheStorage'
import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Mock KVNamespace that stores values in memory
 */
class MockKVNamespace implements KVNamespace {
    private storage = new Map<string, string>()

    async get(key: string): Promise<string | null> {
        return this.storage.get(key) ?? null
    }

    async put(key: string, value: string): Promise<void> {
        this.storage.set(key, value)
    }

    async delete(key: string): Promise<void> {
        this.storage.delete(key)
    }

    async list(): Promise<{
        keys: { name: string; expiration?: number; metadata?: unknown }[]
        list_complete: boolean
        cursor?: string
    }> {
        return {
            keys: Array.from(this.storage.keys()).map((name) => ({ name })),
            list_complete: true,
        }
    }

    // Helper to inspect raw stored values for testing
    getRaw(key: string): string | undefined {
        return this.storage.get(key)
    }
}

describe('KVCacheStorage', () => {
    let mockKV: MockKVNamespace

    beforeEach(() => {
        mockKV = new MockKVNamespace()
    })

    describe('serialization', () => {
        it('should handle regular arrays', async () => {
            const cache = new KVCacheStorage<unknown>(mockKV, {
                keyPostfix: '',
                ttlMs: 60000,
                disableLocalCache: true,
            })

            const regularArray = [1, 2, 3, 'four', { nested: true }]

            await cache.set('regularArray', regularArray)
            const retrieved = (await cache.get('regularArray')) as typeof regularArray

            expect(retrieved).toEqual([1, 2, 3, 'four', { nested: true }])
            expect(retrieved).toHaveLength(5)
        })

        it('should handle plain objects', async () => {
            const cache = new KVCacheStorage<unknown>(mockKV, {
                keyPostfix: '',
                ttlMs: 60000,
                disableLocalCache: true,
            })

            const plainObject = {
                name: 'test',
                value: 123,
                nested: { deep: true },
            }

            await cache.set('plainObject', plainObject)
            const retrieved = await cache.get('plainObject')

            expect(retrieved).toEqual(plainObject)
        })

        it('should handle primitives', async () => {
            const cache = new KVCacheStorage<unknown>(mockKV, {
                keyPostfix: '',
                ttlMs: 60000,
                disableLocalCache: true,
            })

            await cache.set('string', 'hello')
            await cache.set('number', 42)
            await cache.set('boolean', true)
            await cache.set('null', null)

            expect(await cache.get('string')).toBe('hello')
            expect(await cache.get('number')).toBe(42)
            expect(await cache.get('boolean')).toBe(true)
            expect(await cache.get('null')).toBe(null)
        })
    })

    describe('basic cache operations', () => {
        it('should return undefined for missing keys', async () => {
            const cache = new KVCacheStorage<string>(mockKV, {
                keyPostfix: '',
                ttlMs: 60000,
                disableLocalCache: true,
            })

            const result = await cache.get('nonexistent')
            expect(result).toBeUndefined()
        })

        it('should delete cached values', async () => {
            const cache = new KVCacheStorage<string>(mockKV, {
                keyPostfix: '',
                ttlMs: 60000,
                disableLocalCache: true,
            })

            await cache.set('deleteMe', 'value')
            expect(await cache.get('deleteMe')).toBe('value')

            await cache.delete('deleteMe')
            expect(await cache.get('deleteMe')).toBeUndefined()
        })

        it('should apply key postfix', async () => {
            const cache = new KVCacheStorage<string>(mockKV, {
                keyPostfix: 'postfix',
                ttlMs: 60000,
                disableLocalCache: true,
            })

            await cache.set('key', 'value')

            // The raw key in storage should include the postfix
            expect(mockKV.getRaw('key:postfix')).toBeDefined()
            expect(mockKV.getRaw('key')).toBeUndefined()
        })
    })
})
