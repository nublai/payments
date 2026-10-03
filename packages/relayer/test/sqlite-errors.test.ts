import { describe, expect, it } from 'vitest'
import { isPendingTransactionIdUniqueConstraintError } from '../src/lib/sqlite-errors'

describe('isPendingTransactionIdUniqueConstraintError', () => {
    it('matches canonical sqlite unique constraint message', () => {
        expect(
            isPendingTransactionIdUniqueConstraintError(
                'UNIQUE constraint failed: pending_transactions.id',
            ),
        ).toBe(true)
    })

    it('matches sqlite constraint code variants', () => {
        expect(
            isPendingTransactionIdUniqueConstraintError(
                'D1_ERROR: SQLITE_CONSTRAINT: UNIQUE constraint failed: pending_transactions.id',
            ),
        ).toBe(true)
    })

    it('does not match unrelated constraints', () => {
        expect(
            isPendingTransactionIdUniqueConstraintError(
                'UNIQUE constraint failed: bundle_transactions.bundle_id, bundle_transactions.tx_id',
            ),
        ).toBe(false)
    })
})
