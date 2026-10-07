import { DurableObject } from 'cloudflare:workers'

import type { Env } from '../types/env'

/**
 * Wallet bindings are global across every chain this worker serves.
 *
 * An address is one key. A bind signed for chain 31337 still means that key
 * belongs to that (issuer, subject) on every other chain, and a second subject
 * cannot bind the same address on a different chain. The signed chain id stops
 * a nonce minted for one chain from being replayed on another. It does not
 * split ownership. Splitting it would let a second subject sponsor the same
 * key on a chain the first subject did not bind.
 *
 * Storage is one SQLite Durable Object, not D1. This repo has no D1 database,
 * and address uniqueness has to be decided in one transaction.
 */
export const WALLET_BINDING_SCOPE = 'global' as const

/** Conservative caps. A burst past these is refused. Windows are fixed 10 minutes. */
export const BIND_LIMITS = {
    issuePerSubject: 5,
    issuePerIp: 20,
    bindPerSubject: 5,
    bindPerIp: 20,
    windowSeconds: 10 * 60,
    maxBindingsPerSubject: 4,
    maxOpenNoncesPerSubject: 3,
} as const

export class WalletBindingDO extends DurableObject<Env> {
    private sql: SqlStorage

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.sql = ctx.storage.sql
        this.migrateSchema()
    }

    private migrateSchema(): void {
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS bindings (
        address TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_bindings_identity
      ON bindings (issuer, subject);

      CREATE TABLE IF NOT EXISTS bind_nonces (
        nonce TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        address TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS bind_rates (
        bucket TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        hits INTEGER NOT NULL,
        PRIMARY KEY (bucket, window_start)
      );
    `)
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    async fetch(_request: Request): Promise<Response> {
        throw new Error('Fetch not implemented, call methods directly over rpc')
    }

    async alarm(nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
        this.deleteExpired(nowSeconds, true)
        const next = this.sql
            .exec<{ expires_at: number }>(
                `SELECT MIN(expires_at) AS expires_at FROM bind_nonces`,
            )
            .toArray()
            .at(0)
        if (typeof next?.expires_at === 'number' && Number.isFinite(next.expires_at)) {
            await this.scheduleAlarm(next.expires_at)
        }
    }

    async issueNonce(input: {
        issuer: string
        subject: string
        address: string
        chainId: number
        nowSeconds: number
        ttlSeconds: number
        ip?: string
    }): Promise<
        | { ok: true; nonce: string; expiresAt: number }
        | { ok: false; reason: 'address_taken' | 'invalid' | 'rate_limited' | 'subject_cap' }
    > {
        const address = normalizeAddress(input.address)
        if (
            !input.issuer ||
            !input.subject ||
            !address ||
            !Number.isInteger(input.chainId) ||
            !Number.isInteger(input.nowSeconds) ||
            !Number.isInteger(input.ttlSeconds) ||
            input.ttlSeconds < 1 ||
            input.ttlSeconds > 3600
        ) {
            return { ok: false, reason: 'invalid' }
        }

        const nonce = randomNonce()
        const expiresAt = input.nowSeconds + input.ttlSeconds
        const outcome = this.ctx.storage.transactionSync(() => {
            this.deleteExpired(input.nowSeconds, true)
            if (
                !this.charge('issue', input.issuer, input.subject, input.ip, input.nowSeconds)
            ) {
                return { ok: false as const, reason: 'rate_limited' as const }
            }

            const owner = this.ownerRow(address)
            if (owner && (owner.issuer !== input.issuer || owner.subject !== input.subject)) {
                return { ok: false as const, reason: 'address_taken' as const }
            }

            const open = this.count(
                `SELECT COUNT(*) AS n FROM bind_nonces WHERE issuer = ? AND subject = ? AND expires_at > ?`,
                input.issuer,
                input.subject,
                input.nowSeconds,
            )
            if (open >= BIND_LIMITS.maxOpenNoncesPerSubject) {
                return { ok: false as const, reason: 'subject_cap' as const }
            }

            const alreadyOwned = owner !== undefined
            const bindings = this.count(
                `SELECT COUNT(*) AS n FROM bindings WHERE issuer = ? AND subject = ?`,
                input.issuer,
                input.subject,
            )
            if (!alreadyOwned && bindings >= BIND_LIMITS.maxBindingsPerSubject) {
                return { ok: false as const, reason: 'subject_cap' as const }
            }

            this.sql.exec(
                `INSERT INTO bind_nonces (nonce, issuer, subject, address, chain_id, expires_at, used)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
                nonce,
                input.issuer,
                input.subject,
                address,
                input.chainId,
                expiresAt,
            )
            return { ok: true as const, nonce, expiresAt }
        })

        if (outcome.ok && expiresAt * 1000 > Date.now()) {
            await this.scheduleAlarm(expiresAt)
        }
        return outcome
    }

    async bind(input: {
        nonce: string
        issuer: string
        subject: string
        address: string
        chainId: number
        expiry: number
        nowSeconds: number
        ip?: string
        charged?: boolean
    }): Promise<
        | { ok: true }
        | {
              ok: false
              reason:
                  | 'nonce_unknown'
                  | 'nonce_used'
                  | 'nonce_expired'
                  | 'nonce_mismatch'
                  | 'address_taken'
                  | 'rate_limited'
                  | 'subject_cap'
          }
    > {
        const address = normalizeAddress(input.address)
        const outcome = this.ctx.storage.transactionSync(() => {
            this.deleteExpired(input.nowSeconds, false)
            if (
                !input.charged &&
                !this.charge('bind', input.issuer, input.subject, input.ip, input.nowSeconds)
            ) {
                return { ok: false as const, reason: 'rate_limited' as const }
            }

            const nonce = this.sql
                .exec(
                    `SELECT issuer, subject, address, chain_id, expires_at, used
           FROM bind_nonces WHERE nonce = ?`,
                    input.nonce,
                )
                .toArray()
                .at(0) as NonceRow | undefined

            if (!nonce) return { ok: false as const, reason: 'nonce_unknown' as const }
            if (nonce.used) {
                this.sql.exec(`DELETE FROM bind_nonces WHERE nonce = ?`, input.nonce)
                return { ok: false as const, reason: 'nonce_used' as const }
            }
            if (nonce.expires_at <= input.nowSeconds) {
                this.sql.exec(`DELETE FROM bind_nonces WHERE nonce = ?`, input.nonce)
                return { ok: false as const, reason: 'nonce_expired' as const }
            }
            if (
                nonce.issuer !== input.issuer ||
                nonce.subject !== input.subject ||
                nonce.address !== address ||
                nonce.chain_id !== input.chainId ||
                nonce.expires_at !== input.expiry
            ) {
                return { ok: false as const, reason: 'nonce_mismatch' as const }
            }

            const owner = this.ownerRow(address)
            if (owner && (owner.issuer !== input.issuer || owner.subject !== input.subject)) {
                return { ok: false as const, reason: 'address_taken' as const }
            }

            if (!owner) {
                const bindings = this.count(
                    `SELECT COUNT(*) AS n FROM bindings WHERE issuer = ? AND subject = ?`,
                    input.issuer,
                    input.subject,
                )
                if (bindings >= BIND_LIMITS.maxBindingsPerSubject) {
                    return { ok: false as const, reason: 'subject_cap' as const }
                }
                this.sql.exec(
                    `INSERT INTO bindings (address, issuer, subject, chain_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
                    address,
                    input.issuer,
                    input.subject,
                    input.chainId,
                    input.nowSeconds,
                )
            }

            this.sql.exec(`DELETE FROM bind_nonces WHERE nonce = ?`, input.nonce)
            return { ok: true as const }
        })

        return outcome
    }

    /** Counts a bind RPC attempt before signature verification so a bad signature still spends the budget. */
    async chargeBind(input: {
        issuer: string
        subject: string
        ip?: string
        nowSeconds: number
    }): Promise<{ ok: true } | { ok: false; reason: 'rate_limited' }> {
        const allowed = this.ctx.storage.transactionSync(() =>
            this.charge('bind', input.issuer, input.subject, input.ip, input.nowSeconds),
        )
        return allowed ? { ok: true } : { ok: false, reason: 'rate_limited' }
    }

    async accountsFor(issuer: string, subject: string): Promise<string[]> {
        return this.sql
            .exec<{ address: string }>(
                `SELECT address FROM bindings WHERE issuer = ? AND subject = ? ORDER BY created_at ASC, address ASC`,
                issuer,
                subject,
            )
            .toArray()
            .map((row) => row.address)
    }

    async ownerOf(address: string): Promise<{ issuer: string; subject: string } | null> {
        const row = this.ownerRow(normalizeAddress(address))
        if (!row) return null
        return { issuer: row.issuer, subject: row.subject }
    }

    private deleteExpired(nowSeconds: number, inclusive: boolean): void {
        this.sql.exec(
            inclusive
                ? `DELETE FROM bind_nonces WHERE expires_at <= ?`
                : `DELETE FROM bind_nonces WHERE expires_at < ?`,
            nowSeconds,
        )
        const staleWindow = nowSeconds - BIND_LIMITS.windowSeconds
        this.sql.exec(`DELETE FROM bind_rates WHERE window_start < ?`, staleWindow)
    }

    private charge(
        kind: 'issue' | 'bind',
        issuer: string,
        subject: string,
        ip: string | undefined,
        nowSeconds: number,
    ): boolean {
        const windowStart = nowSeconds - (nowSeconds % BIND_LIMITS.windowSeconds)
        const subjectBucket = `${kind}:subject:${issuer}\n${subject}`
        const subjectLimit =
            kind === 'issue' ? BIND_LIMITS.issuePerSubject : BIND_LIMITS.bindPerSubject
        const ipBucket = ip ? `${kind}:ip:${ip}` : undefined
        const ipLimit = kind === 'issue' ? BIND_LIMITS.issuePerIp : BIND_LIMITS.bindPerIp
        // A full IP bucket must not consume the subject window. Commit neither hit
        // unless both buckets still have room. The caller holds transactionSync.
        if (!this.hasRoom(subjectBucket, windowStart, subjectLimit)) return false
        if (ipBucket && !this.hasRoom(ipBucket, windowStart, ipLimit)) return false
        this.recordHit(subjectBucket, windowStart)
        if (ipBucket) this.recordHit(ipBucket, windowStart)
        return true
    }

    private hasRoom(bucket: string, windowStart: number, limit: number): boolean {
        return this.currentHits(bucket, windowStart) < limit
    }

    private currentHits(bucket: string, windowStart: number): number {
        const row = this.sql
            .exec<{ hits: number }>(
                `SELECT hits FROM bind_rates WHERE bucket = ? AND window_start = ?`,
                bucket,
                windowStart,
            )
            .toArray()
            .at(0)
        return Number(row?.hits ?? 0)
    }

    private recordHit(bucket: string, windowStart: number): void {
        const row = this.sql
            .exec<{ hits: number }>(
                `SELECT hits FROM bind_rates WHERE bucket = ? AND window_start = ?`,
                bucket,
                windowStart,
            )
            .toArray()
            .at(0)
        if (row) {
            this.sql.exec(
                `UPDATE bind_rates SET hits = ? WHERE bucket = ? AND window_start = ?`,
                Number(row.hits) + 1,
                bucket,
                windowStart,
            )
            return
        }
        this.sql.exec(
            `INSERT INTO bind_rates (bucket, window_start, hits) VALUES (?, ?, 1)`,
            bucket,
            windowStart,
        )
    }

    private count(query: string, ...bindings: (string | number)[]): number {
        const row = this.sql
            .exec<{ n: number }>(query, ...bindings)
            .toArray()
            .at(0)
        return Number(row?.n ?? 0)
    }

    private ownerRow(address: string): { issuer: string; subject: string } | undefined {
        return this.sql
            .exec<{ issuer: string; subject: string }>(
                `SELECT issuer, subject FROM bindings WHERE address = ?`,
                address,
            )
            .toArray()
            .at(0)
    }

    private async scheduleAlarm(expiresAt: number): Promise<void> {
        const nowMs = Date.now()
        const nextMs = Math.max(nowMs, expiresAt * 1000)
        const current = await this.ctx.storage.getAlarm()
        if (current === null || current < nowMs || nextMs < current) {
            await this.ctx.storage.setAlarm(nextMs)
        }
    }
}

interface NonceRow {
    issuer: string
    subject: string
    address: string
    chain_id: number
    expires_at: number
    used: number
}

export const WALLET_BINDING_OBJECT = 'wallet-bindings'

function normalizeAddress(address: string): string {
    return address.trim().toLowerCase()
}

function randomNonce(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    let hex = ''
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0')
    }
    return hex
}
