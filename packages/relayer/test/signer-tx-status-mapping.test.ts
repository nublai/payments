import { describe, expect, it } from 'vitest'
import { mapStoredTxStatusToPublicStatus } from '../src/durable-objects/signer-replacement-policy'

describe('mapStoredTxStatusToPublicStatus', () => {
    it('maps pending to pending', () => {
        expect(mapStoredTxStatusToPublicStatus('pending')).toBe('pending')
    })

    it('maps confirmed to confirmed', () => {
        expect(mapStoredTxStatusToPublicStatus('confirmed')).toBe('confirmed')
    })

    it('maps failed to failed', () => {
        expect(mapStoredTxStatusToPublicStatus('failed')).toBe('failed')
    })

    it('maps stuck to failed', () => {
        expect(mapStoredTxStatusToPublicStatus('stuck')).toBe('failed')
    })

    it('maps abandoned to failed', () => {
        expect(mapStoredTxStatusToPublicStatus('abandoned')).toBe('failed')
    })

    it('defaults unknown statuses to pending', () => {
        expect(mapStoredTxStatusToPublicStatus('queued')).toBe('pending')
    })
})
