/**
 * SQLite error helpers for resilient/idempotent error handling.
 */
export function isPendingTransactionIdUniqueConstraintError(errorMessage: string): boolean {
    const message = errorMessage.toLowerCase()

    return (
        message.includes('unique constraint failed: pending_transactions.id') ||
        (message.includes('sqlite_constraint') &&
            message.includes('pending_transactions') &&
            message.includes('.id'))
    )
}
