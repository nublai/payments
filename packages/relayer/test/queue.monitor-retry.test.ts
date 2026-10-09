import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import type { MonitorJob } from '../src/types/pool'
import type { Env } from '../src/types/env'
import { testEnv } from './helpers/env'
import { parseJson } from './helpers/rpc'
import { jsonStub, queueBatch, signerNamespace } from './helpers/stubs'

function createMonitorMessage(overrides?: {
    attempts?: number
    bodyAttempt?: number
    chainId?: number
}) {
    const ack = vi.fn()
    const retry = vi.fn()

    return {
        message: {
            body: {
                type: 'monitor',
                txId: 'tx-1',
                txHash: '0x1',
                signerName: 'signer-137-0',
                chainId: overrides?.chainId ?? 137,
                attempt: overrides?.bodyAttempt ?? 0,
            } satisfies MonitorJob,
            attempts: overrides?.attempts ?? 0,
            ack,
            retry,
        },
        ack,
        retry,
    }
}

function createMonitorEnv(options?: { signerFetch?: ReturnType<typeof vi.fn> }): Env {
    return testEnv({
        CHAIN_IDS: '137',
        RPC_137: 'https://polygon.example',
        SIGNER: signerNamespace({
            idFromName: vi.fn().mockReturnValue('signer-id'),
            get: vi.fn().mockReturnValue({
                fetch: options?.signerFetch ?? vi.fn().mockResolvedValue(jsonStub({}, true)),
            }),
        }),
    })
}

describe('monitor queue retry behavior', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('uses queue-managed attempts for retry backoff (not body.attempt)', async () => {
        const { message, ack, retry } = createMonitorMessage({ attempts: 3, bodyAttempt: 99 })

        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonStub({ result: null }))

        const batch = queueBatch([message])
        const env = createMonitorEnv()

        await worker.queue(batch, env)

        expect(fetchMock).toHaveBeenCalled()
        expect(retry).toHaveBeenCalledWith({ delaySeconds: 8 })
        expect(ack).not.toHaveBeenCalled()
    })

    it('finalizes as failed and acks when attempts are exhausted', async () => {
        const signerFetch = vi.fn().mockResolvedValue(jsonStub({}, true))
        const { message, ack, retry } = createMonitorMessage({ attempts: 30 })
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonStub({ result: null }))
        const batch = queueBatch([message])
        const env = createMonitorEnv({ signerFetch })

        await worker.queue(batch, env)

        expect(signerFetch).toHaveBeenCalledTimes(1)
        expect(signerFetch.mock.calls[0]?.[1]).toMatchObject({
            method: 'POST',
        })

        const body = parseJson<{ status?: string }>(String(signerFetch.mock.calls[0]?.[1]?.body ?? '{}'))

        expect(body.status).toBe('failed')
        expect(ack).toHaveBeenCalledTimes(1)
        expect(retry).not.toHaveBeenCalled()
    })

    it('retries when finalization callback fails after receipt is found', async () => {
        const signerFetch = vi.fn().mockResolvedValue(jsonStub({}, false))
        const { message, ack, retry } = createMonitorMessage({ attempts: 1 })

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonStub({
                result: { status: '0x1', gasUsed: '0x5208' },
            }),
        )

        const batch = queueBatch([message])
        const env = createMonitorEnv({ signerFetch })

        await worker.queue(batch, env)

        expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 })
        expect(ack).not.toHaveBeenCalled()
    })

    it('retries when exhausted retries cannot finalize as failed', async () => {
        const signerFetch = vi.fn().mockResolvedValue(jsonStub({}, false))
        const { message, ack, retry } = createMonitorMessage({ attempts: 30 })

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonStub({ result: null }))

        const batch = queueBatch([message])
        const env = createMonitorEnv({ signerFetch })

        await worker.queue(batch, env)

        expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 })
        expect(ack).not.toHaveBeenCalled()
    })

    it('retries on thrown monitor errors even when attempts are exhausted', async () => {
        const signerFetch = vi.fn().mockResolvedValue(jsonStub({}, true))
        const { message, ack, retry } = createMonitorMessage({ attempts: 30 })
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('rpc unavailable'))
        const batch = queueBatch([message])
        const env = createMonitorEnv({ signerFetch })

        await worker.queue(batch, env)

        expect(signerFetch).not.toHaveBeenCalled()
        expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 })
        expect(ack).not.toHaveBeenCalled()
    })

    it('acks malformed payload and continues processing remaining messages', async () => {
        const malformedAck = vi.fn()
        const malformedRetry = vi.fn()

        const malformedMessage = {
            body: null,
            attempts: 0,
            ack: malformedAck,
            retry: malformedRetry,
        }

        const {
            message: validMessage,
            ack: validAck,
            retry: validRetry,
        } = createMonitorMessage({
            attempts: 3,
            bodyAttempt: 99,
        })

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonStub({ result: null }))

        const batch = queueBatch<MonitorJob>([
            {
                ...malformedMessage,
                // SAFETY: handleQueue only reads body/attempts/ack/retry; the first message is a null body on purpose.
                body: malformedMessage.body as never,
            },
            validMessage,
        ])

        const env = createMonitorEnv()

        await worker.queue(batch, env)

        expect(malformedAck).toHaveBeenCalledTimes(1)
        expect(malformedRetry).not.toHaveBeenCalled()
        expect(validRetry).toHaveBeenCalledWith({ delaySeconds: 8 })
        expect(validAck).not.toHaveBeenCalled()
    })
})
