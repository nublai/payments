import { describe, it, expect, vi } from 'vitest'
import worker from '../src/index'
import { queueBatch, queueBinding, testEnv } from './helpers/env'

describe('queue retired escrow-bridging jobs', () => {
    it('acks retired fulfillment job instead of retrying', async () => {
        const ack = vi.fn()
        const retry = vi.fn()

        const retired = {
            type: 'fulfillment',
            bundleId: 'bundle-1',
        }

        const batch = queueBatch<unknown>([
            {
                body: retired,
                ack,
                retry,
            },
        ])

        const env = testEnv({
            CHAIN_IDS: '8453',
            MONITOR_QUEUE: queueBinding({ send: vi.fn() }),
        })

        await worker.queue(batch, env)

        expect(ack).toHaveBeenCalledTimes(1)
        expect(retry).not.toHaveBeenCalled()
    })
})
