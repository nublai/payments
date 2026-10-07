/**
 * Try another signer only when this attempt returned before
 * eth_sendRawTransaction. The error text is not part of the decision.
 */
export function signerSendDisposition(attempt: {
    broadcastAttempted: boolean
    message?: string
}): 'retry' | 'keep' {
    return attempt.broadcastAttempted ? 'keep' : 'retry'
}

/** True when any candidate in the round already submitted a transaction. */
export function poolSendBroadcastAttempted(
    attempts: Array<{ broadcastAttempted: boolean; message?: string }>,
): boolean {
    return attempts.some((attempt) => attempt.broadcastAttempted)
}
