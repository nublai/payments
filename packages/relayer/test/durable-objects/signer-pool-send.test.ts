import { describe, expect, it } from 'vitest'

import {
    poolSendBroadcastAttempted,
    signerSendDisposition,
} from '../../src/durable-objects/signer-pool-send'

describe('signer pool send disposition', () => {
    it('keeps the slot when a post-send error mentions capacity or paused', () => {
        const capacity = {
            broadcastAttempted: true,
            message: 'txpool capacity exceeded',
        }

        const paused = {
            broadcastAttempted: true,
            message: 'signer is paused',
        }

        expect(signerSendDisposition(capacity)).toBe('keep')
        expect(poolSendBroadcastAttempted([capacity])).toBe(true)
        expect(signerSendDisposition(paused)).toBe('keep')
        expect(poolSendBroadcastAttempted([paused])).toBe(true)

        const beforeSend = [
            { broadcastAttempted: false, message: 'Signer at capacity' },
            { broadcastAttempted: false, message: 'Signer is paused' },
        ]

        expect(beforeSend.every((attempt) => signerSendDisposition(attempt) === 'retry')).toBe(true)
        expect(poolSendBroadcastAttempted(beforeSend)).toBe(false)
    })
})