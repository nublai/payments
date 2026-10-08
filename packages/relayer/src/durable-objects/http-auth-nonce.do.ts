import { DurableObject } from 'cloudflare:workers'

import type { Env } from '../types/env'

export class HttpAuthNonceDO extends DurableObject<Env> {
    private sql: SqlStorage

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.sql = ctx.storage.sql
        this.migrateSchema()
    }

    private migrateSchema(): void {
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nonces (
        replay_key TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nonces_expires_at
      ON nonces (expires_at);
    `)
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    async fetch(_request: Request): Promise<Response> {
        throw new Error('Fetch not implemented, call methods directly over rpc')
    }

    async consumeNonce(replayKey: string, ttlSeconds: number): Promise<boolean> {
        if (!replayKey || !Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
            return false
        }

        const nowUnixSeconds = Math.floor(Date.now() / 1000)
        const expiryUnixSeconds = nowUnixSeconds + Math.floor(ttlSeconds)
        const accepted = this.consumeNonceSync(replayKey, expiryUnixSeconds, nowUnixSeconds)

        if (accepted) {
            await this.scheduleCleanupAlarmIfNeeded(expiryUnixSeconds)
        }

        return accepted
    }

    async alarm(): Promise<void> {
        const nowUnixSeconds = Math.floor(Date.now() / 1000)
        this.cleanupExpiredNonces(nowUnixSeconds)

        const nextExpiryRow = this.sql
            .exec<{ expires_at: number }>('SELECT MIN(expires_at) AS expires_at FROM nonces')
            .toArray()
            .at(0)

        const nextExpiryUnixSeconds = nextExpiryRow?.expires_at

        if (typeof nextExpiryUnixSeconds === 'number' && Number.isFinite(nextExpiryUnixSeconds)) {
            await this.scheduleCleanupAlarmIfNeeded(nextExpiryUnixSeconds)
        }
    }

    private consumeNonceSync(
        replayKey: string,
        expiryUnixSeconds: number,
        nowUnixSeconds: number,
    ): boolean {
        const result = this.ctx.storage.transactionSync(() => {
            const existing = this.sql
                .exec<{
                    expires_at: number
                }>('SELECT expires_at FROM nonces WHERE replay_key = ?', replayKey)
                .toArray()
                .at(0)

            if (existing && existing.expires_at >= nowUnixSeconds) {
                return false
            }

            if (existing) {
                this.sql.exec('DELETE FROM nonces WHERE replay_key = ?', replayKey)
            }

            this.sql.exec(
                'INSERT INTO nonces (replay_key, expires_at) VALUES (?, ?)',
                replayKey,
                expiryUnixSeconds,
            )

            return true
        })

        return result as boolean
    }

    private cleanupExpiredNonces(nowUnixSeconds: number): void {
        this.sql.exec('DELETE FROM nonces WHERE expires_at <= ?', nowUnixSeconds)
    }

    private async scheduleCleanupAlarmIfNeeded(expiryUnixSeconds: number): Promise<void> {
        const nowUnixMilliseconds = Date.now()
        const nextCleanupAtMs = expiryUnixSeconds * 1000
        const currentAlarmAtMs = await this.ctx.storage.getAlarm()

        if (
            currentAlarmAtMs === null ||
            currentAlarmAtMs < nowUnixMilliseconds ||
            nextCleanupAtMs < currentAlarmAtMs
        ) {
            await this.ctx.storage.setAlarm(Math.max(nowUnixMilliseconds, nextCleanupAtMs))
        }
    }
}
