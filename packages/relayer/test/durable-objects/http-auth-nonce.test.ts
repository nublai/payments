import { describe, expect, it } from 'vitest'

interface NonceRow {
    replayKey: string
    expiresAtUnixSeconds: number
}

function consumeNonce(
    rows: Map<string, NonceRow>,
    replayKey: string,
    ttlSeconds: number,
    nowUnixSeconds: number,
): { accepted: boolean; expiresAtUnixSeconds: number } {
    const normalizedTtlSeconds = Math.max(0, Math.floor(ttlSeconds))
    const expiresAtUnixSeconds = nowUnixSeconds + normalizedTtlSeconds
    const existing = rows.get(replayKey)
    if (existing && existing.expiresAtUnixSeconds >= nowUnixSeconds) {
        return { accepted: false, expiresAtUnixSeconds }
    }

    rows.set(replayKey, { replayKey, expiresAtUnixSeconds })
    return { accepted: true, expiresAtUnixSeconds }
}

function cleanupExpiredNonces(rows: Map<string, NonceRow>, nowUnixSeconds: number): void {
    for (const [key, row] of rows.entries()) {
        if (row.expiresAtUnixSeconds <= nowUnixSeconds) {
            rows.delete(key)
        }
    }
}

function scheduleCleanupAlarmAtMs(
    currentAlarmAtMs: number | null,
    expiresAtUnixSeconds: number,
    nowUnixMilliseconds: number,
): number {
    const nextCleanupAtMs = expiresAtUnixSeconds * 1000
    if (
        currentAlarmAtMs === null ||
        currentAlarmAtMs < nowUnixMilliseconds ||
        nextCleanupAtMs < currentAlarmAtMs
    ) {
        return Math.max(nowUnixMilliseconds, nextCleanupAtMs)
    }
    return currentAlarmAtMs
}

describe('HttpAuthNonceDO semantics', () => {
    it('accepts first consume and rejects duplicate consume', () => {
        const rows = new Map<string, NonceRow>()
        const nowUnixSeconds = 1_700_000_000

        const first = consumeNonce(rows, 'key:nonce', 60, nowUnixSeconds)
        const second = consumeNonce(rows, 'key:nonce', 60, nowUnixSeconds)

        expect(first.accepted).toBe(true)
        expect(second.accepted).toBe(false)
    })

    it('accepts same key after ttl expiry even before alarm cleanup runs', () => {
        const rows = new Map<string, NonceRow>()
        const nowUnixSeconds = 1_700_000_000

        const first = consumeNonce(rows, 'key:nonce', 10, nowUnixSeconds)
        const afterExpiry = consumeNonce(rows, 'key:nonce', 20, nowUnixSeconds + 11)

        expect(first.accepted).toBe(true)
        expect(afterExpiry.accepted).toBe(true)
    })

    it('rejects replay at exact expiry boundary and accepts after boundary', () => {
        const rows = new Map<string, NonceRow>()
        const nowUnixSeconds = 1_700_000_000

        const first = consumeNonce(rows, 'key:nonce', 0, nowUnixSeconds)
        const replayAtBoundary = consumeNonce(rows, 'key:nonce', 10, nowUnixSeconds)
        const afterBoundary = consumeNonce(rows, 'key:nonce', 20, nowUnixSeconds + 1)

        expect(first.accepted).toBe(true)
        expect(replayAtBoundary.accepted).toBe(false)
        expect(afterBoundary.accepted).toBe(true)
    })

    it('removes nonce at exact expiry boundary during cleanup', () => {
        const rows = new Map<string, NonceRow>()
        const nowUnixSeconds = 1_700_000_000

        consumeNonce(rows, 'key:nonce', 10, nowUnixSeconds)
        cleanupExpiredNonces(rows, nowUnixSeconds + 10)

        expect(rows.has('key:nonce')).toBe(false)
    })

    it('schedules cleanup alarm for earliest expiry and removes only expired rows', () => {
        const rows = new Map<string, NonceRow>()
        const nowUnixSeconds = 1_700_000_000
        const nowUnixMilliseconds = nowUnixSeconds * 1000
        let currentAlarmAtMs: number | null = null

        const shortTtl = consumeNonce(rows, 'key:short', 5, nowUnixSeconds)
        currentAlarmAtMs = scheduleCleanupAlarmAtMs(
            currentAlarmAtMs,
            shortTtl.expiresAtUnixSeconds,
            nowUnixMilliseconds,
        )

        const longTtl = consumeNonce(rows, 'key:long', 60, nowUnixSeconds)
        currentAlarmAtMs = scheduleCleanupAlarmAtMs(
            currentAlarmAtMs,
            longTtl.expiresAtUnixSeconds,
            nowUnixMilliseconds,
        )

        expect(currentAlarmAtMs).toBe(shortTtl.expiresAtUnixSeconds * 1000)

        cleanupExpiredNonces(rows, nowUnixSeconds + 6)
        expect(rows.has('key:short')).toBe(false)
        expect(rows.has('key:long')).toBe(true)
    })
})
