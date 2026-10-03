import { describe, it, expect, vi } from 'vitest'
import worker from '../src/index'

describe('queue retired escrow-bridging jobs', () => {
    it('acks retired fulfillment job instead of retrying', async () => {
        const ack = vi.fn()
        const retry = vi.fn()

        const batch = {
            messages: [
                {
                    body: {
                        type: 'fulfillment',
                        bundleId: 'bundle-1',
                    },
                    ack,
                    retry,
                },
            ],
        } as unknown as MessageBatch<unknown>

        const env = {
            CHAIN_IDS: '8453',
            MONITOR_QUEUE: { send: vi.fn() },
        } as unknown as Parameters<typeof worker.queue>[1]

        await worker.queue(batch as never, env)

        expect(ack).toHaveBeenCalledTimes(1)
        expect(retry).not.toHaveBeenCalled()
    })
})
