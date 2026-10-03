/**
 * IntentNonceDO - Durable Object for account intent nonce management
 *
 * Manages 2D nonces for user accounts. Each account gets its own Durable Object
 * instance (keyed by account address) ensuring sequential nonce allocation
 * without race conditions.
 *
 * 2D Nonce Format:
 * - Upper 192 bits: seqKey (sequence key for parallel operations)
 * - Lower 64 bits: seq (sequential counter within that key)
 *
 * Storage: SQLite for better performance and atomic operations
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types/env'
import { getErrorMessage } from '../lib/logger'

interface NonceRow {
    seq_key: string
    seq: string
}

interface PendingDraftRow {
    seq_key: string
    draft_id: string
    nonce: string
    draft_key: string | null
    created_at_ms: number
    expires_at_ms: number
}

interface AcquireOrGetDraftResult {
    nonce: bigint
    draftId: string
    createdAtMs: number
    expiresAtMs: number
    fromCache: boolean
}

interface AcquireOrGetDraftConflict {
    error: string
    conflictDraftId: string
}

type DraftMutationStatus = 'cleared' | 'not_found' | 'mismatch'

const MAX_SEQ_KEY = 2n ** 192n
const MAX_SEQ = 2n ** 64n

const DEFAULT_DRAFT_TTL_MS = 10 * 60 * 1000
const MIN_DRAFT_TTL_MS = 60 * 1000
const MAX_DRAFT_TTL_MS = 60 * 60 * 1000

function toNonceRow(row: Record<string, unknown>): NonceRow {
    return {
        seq_key: String(row.seq_key),
        seq: String(row.seq),
    }
}

function toPendingDraftRow(row: Record<string, unknown>): PendingDraftRow {
    return {
        seq_key: String(row.seq_key),
        draft_id: String(row.draft_id),
        nonce: String(row.nonce),
        draft_key: row.draft_key === null ? null : String(row.draft_key),
        created_at_ms: Number(row.created_at_ms),
        expires_at_ms: Number(row.expires_at_ms),
    }
}

function getSeqFromRows(rows: unknown[]): bigint {
    if (rows.length === 0) return 0n
    return BigInt(String((rows[0] as Record<string, unknown>).seq))
}

function coerceDraftTtlMs(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_DRAFT_TTL_MS
    }

    const rounded = Math.floor(value)
    if (rounded < MIN_DRAFT_TTL_MS) return MIN_DRAFT_TTL_MS
    if (rounded > MAX_DRAFT_TTL_MS) return MAX_DRAFT_TTL_MS
    return rounded
}

export class IntentNonceDO extends DurableObject<Env> {
    private sql: SqlStorage

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.sql = ctx.storage.sql
        this.migrateSchema()
    }

    /**
     * SQLite schema migration
     */
    private migrateSchema(): void {
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nonces (
        seq_key TEXT PRIMARY KEY,
        seq TEXT NOT NULL DEFAULT '0'
      );
    `)

        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_drafts (
        seq_key TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        draft_key TEXT,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `)

        this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_pending_drafts_expires_at_ms
      ON pending_drafts (expires_at_ms);
    `)
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)

        try {
            switch (url.pathname) {
                case '/acquire': {
                    // Acquire the next nonce for a sequence key
                    const { seqKey } = (await request.json()) as { seqKey: string }
                    const seqKeyBigInt = this.parseSeqKey(seqKey)
                    if (seqKeyBigInt === null) {
                        return Response.json(
                            { error: 'seqKey must be in range [0, 2^192)' },
                            { status: 400 },
                        )
                    }

                    const nonce = this.acquireNonce(seqKeyBigInt)
                    return Response.json({ nonce: nonce.toString() })
                }

                case '/peek': {
                    // Get current nonce without incrementing
                    const { seqKey } = (await request.json()) as { seqKey: string }
                    const seqKeyBigInt = this.parseSeqKey(seqKey)
                    if (seqKeyBigInt === null) {
                        return Response.json(
                            { error: 'seqKey must be in range [0, 2^192)' },
                            { status: 400 },
                        )
                    }

                    const nonce = this.peekNonce(seqKeyBigInt)
                    return Response.json({ nonce: nonce.toString() })
                }

                case '/sync': {
                    // Sync with on-chain state
                    const { seqKey, confirmedSeq } = (await request.json()) as {
                        seqKey: string
                        confirmedSeq: string
                    }

                    const seqKeyBigInt = this.parseSeqKey(seqKey)
                    if (seqKeyBigInt === null) {
                        return Response.json(
                            { error: 'seqKey must be in range [0, 2^192)' },
                            { status: 400 },
                        )
                    }

                    this.syncNonce(seqKeyBigInt, BigInt(confirmedSeq))
                    return Response.json({ ok: true })
                }

                case '/status': {
                    // Get all tracked nonces and pending drafts
                    const rows = this.sql.exec('SELECT seq_key, seq FROM nonces').toArray()
                    const nonces: Record<string, string> = {}
                    for (const row of rows) {
                        const typed = toNonceRow(row as Record<string, unknown>)
                        nonces[typed.seq_key] = typed.seq
                    }

                    const draftsRows = this.sql
                        .exec(
                            'SELECT seq_key, draft_id, nonce, draft_key, created_at_ms, expires_at_ms FROM pending_drafts',
                        )
                        .toArray()
                    const drafts: Record<
                        string,
                        {
                            draftId: string
                            nonce: string
                            draftKey: string | null
                            createdAtMs: number
                            expiresAtMs: number
                        }
                    > = {}
                    for (const row of draftsRows) {
                        const typed = toPendingDraftRow(row as Record<string, unknown>)
                        drafts[typed.seq_key] = {
                            draftId: typed.draft_id,
                            nonce: typed.nonce,
                            draftKey: typed.draft_key,
                            createdAtMs: typed.created_at_ms,
                            expiresAtMs: typed.expires_at_ms,
                        }
                    }

                    return Response.json({ nonces, drafts })
                }

                case '/reset': {
                    // Reset a specific sequence key
                    const { seqKey } = (await request.json()) as { seqKey: string }
                    const seqKeyBigInt = this.parseSeqKey(seqKey)
                    if (seqKeyBigInt === null) {
                        return Response.json(
                            { error: 'seqKey must be in range [0, 2^192)' },
                            { status: 400 },
                        )
                    }

                    this.resetNonce(seqKeyBigInt)
                    return Response.json({ ok: true })
                }

                case '/acquire_synced': {
                    // Acquire nonce with drift detection and correction
                    // If local is ahead of chain, sync first to prevent InvalidNonce errors
                    const { seqKey, onChainSeq } = (await request.json()) as {
                        seqKey: string
                        onChainSeq: string
                    }
                    const seqKeyBigInt = this.parseSeqKey(seqKey)
                    if (seqKeyBigInt === null) {
                        return Response.json(
                            { error: 'seqKey must be in range [0, 2^192)' },
                            { status: 400 },
                        )
                    }

                    const onChainSeqBigInt = this.parseSeq(onChainSeq)
                    if (onChainSeqBigInt === null) {
                        return Response.json(
                            {
                                error: 'onChainSeq must be in range [0, 2^64) - pass seq portion, not full nonce',
                            },
                            { status: 400 },
                        )
                    }

                    const { nonce, synced } = this.acquireNonceSynced(
                        seqKeyBigInt,
                        onChainSeqBigInt,
                    )
                    return Response.json({ nonce: nonce.toString(), synced })
                }

                case '/acquire_or_get_draft': {
                    const { seqKey, onChainSeq, draftKey, draftTtlMs } = (await request.json()) as {
                        seqKey: string
                        onChainSeq: string
                        draftKey?: string
                        draftTtlMs?: number
                    }

                    const seqKeyBigInt = this.parseSeqKey(seqKey)
                    if (seqKeyBigInt === null) {
                        return Response.json(
                            { error: 'seqKey must be in range [0, 2^192)' },
                            { status: 400 },
                        )
                    }

                    const onChainSeqBigInt = this.parseSeq(onChainSeq)
                    if (onChainSeqBigInt === null) {
                        return Response.json(
                            {
                                error: 'onChainSeq must be in range [0, 2^64) - pass seq portion, not full nonce',
                            },
                            { status: 400 },
                        )
                    }

                    const result = this.acquireOrGetDraft(seqKeyBigInt, onChainSeqBigInt, {
                        draftKey,
                        draftTtlMs: coerceDraftTtlMs(draftTtlMs),
                    })
                    if ('error' in result) {
                        return Response.json(
                            {
                                error: result.error,
                                conflictDraftId: result.conflictDraftId,
                            },
                            { status: 409 },
                        )
                    }

                    return Response.json({
                        nonce: result.nonce.toString(),
                        draftId: result.draftId,
                        createdAtMs: result.createdAtMs,
                        expiresAtMs: result.expiresAtMs,
                        fromCache: result.fromCache,
                    })
                }

                case '/mark_submitted': {
                    const { seqKey, draftId } = (await request.json()) as {
                        seqKey: string
                        draftId: string
                    }

                    const seqKeyBigInt = this.parseSeqKey(seqKey)
                    if (seqKeyBigInt === null) {
                        return Response.json(
                            { error: 'seqKey must be in range [0, 2^192)' },
                            { status: 400 },
                        )
                    }
                    if (!draftId || typeof draftId !== 'string') {
                        return Response.json({ error: 'draftId is required' }, { status: 400 })
                    }

                    const status = this.markSubmitted(seqKeyBigInt, draftId)
                    return Response.json({ ok: true, status })
                }

                case '/cancel_draft': {
                    const { seqKey, draftId } = (await request.json()) as {
                        seqKey: string
                        draftId?: string
                    }

                    const seqKeyBigInt = this.parseSeqKey(seqKey)
                    if (seqKeyBigInt === null) {
                        return Response.json(
                            { error: 'seqKey must be in range [0, 2^192)' },
                            { status: 400 },
                        )
                    }

                    const status = this.cancelDraft(seqKeyBigInt, draftId)
                    return Response.json({ ok: true, status })
                }

                default:
                    return new Response('Not found', { status: 404 })
            }
        } catch (error) {
            const message = getErrorMessage(error)
            return Response.json({ error: message }, { status: 500 })
        }
    }

    private parseSeqKey(seqKey: string): bigint | null {
        try {
            const seqKeyBigInt = BigInt(seqKey)
            if (seqKeyBigInt < 0n || seqKeyBigInt >= MAX_SEQ_KEY) {
                return null
            }
            return seqKeyBigInt
        } catch {
            return null
        }
    }

    private parseSeq(seq: string): bigint | null {
        try {
            const seqBigInt = BigInt(seq)
            if (seqBigInt < 0n || seqBigInt >= MAX_SEQ) {
                return null
            }
            return seqBigInt
        } catch {
            return null
        }
    }

    /**
     * Acquire the next available nonce for a sequence key
     *
     * Returns the full 256-bit nonce and increments the counter.
     * Uses SQLite UPSERT for atomic increment.
     */
    private acquireNonce(seqKey: bigint): bigint {
        const key = seqKey.toString()

        // Atomic: insert if not exists, then increment and return previous value
        // Using transactionSync for atomicity
        const result = this.ctx.storage.transactionSync(() => {
            // Get current value (or 0 if not exists)
            const rows = this.sql.exec('SELECT seq FROM nonces WHERE seq_key = ?', key).toArray()
            const currentSeq = getSeqFromRows(rows)
            const nextSeq = currentSeq + 1n

            // Upsert with incremented value
            this.sql.exec(
                `INSERT INTO nonces (seq_key, seq) VALUES (?, ?)
         ON CONFLICT(seq_key) DO UPDATE SET seq = ?`,
                key,
                nextSeq.toString(),
                nextSeq.toString(),
            )

            return currentSeq
        })

        const seq = result as bigint
        return (seqKey << 64n) | seq
    }

    /**
     * Peek at the current nonce without incrementing
     */
    private peekNonce(seqKey: bigint): bigint {
        const key = seqKey.toString()
        const rows = this.sql.exec('SELECT seq FROM nonces WHERE seq_key = ?', key).toArray()
        const seq = getSeqFromRows(rows)
        return (seqKey << 64n) | seq
    }

    /**
     * Sync nonce with on-chain state
     *
     * Called after querying the chain to ensure DO state matches.
     * Always updates local state to match chain state - this is the authoritative sync.
     * Use this when you know the on-chain nonce and want to reconcile drift.
     */
    private syncNonce(seqKey: bigint, confirmedSeq: bigint): void {
        const key = seqKey.toString()

        this.ctx.storage.transactionSync(() => {
            // Always update to match chain state - chain is authoritative
            this.sql.exec(
                `INSERT INTO nonces (seq_key, seq) VALUES (?, ?)
           ON CONFLICT(seq_key) DO UPDATE SET seq = ?`,
                key,
                confirmedSeq.toString(),
                confirmedSeq.toString(),
            )
        })
    }

    /**
     * Reset nonce for a sequence key
     */
    private resetNonce(seqKey: bigint): void {
        const key = seqKey.toString()
        this.sql.exec('DELETE FROM nonces WHERE seq_key = ?', key)
        this.sql.exec('DELETE FROM pending_drafts WHERE seq_key = ?', key)
    }

    /**
     * Acquire nonce with drift detection and automatic correction
     *
     * Compares local state against provided on-chain nonce:
     * - If local seq < onChainSeq: We're behind chain, fast-forward first
     * - If local seq >= onChainSeq: Allocate from local without rewind
     *
     * Returns the acquired nonce and whether a sync occurred
     */
    private acquireNonceSynced(
        seqKey: bigint,
        onChainSeq: bigint,
    ): { nonce: bigint; synced: boolean } {
        const key = seqKey.toString()

        const result = this.ctx.storage.transactionSync(() => {
            const rows = this.sql.exec('SELECT seq FROM nonces WHERE seq_key = ?', key).toArray()
            let currentSeq = getSeqFromRows(rows)
            let synced = false

            // Monotonic allocation: only fast-forward when local is behind chain.
            // Never rewind on stale on-chain reads; that can re-issue old nonces.
            if (currentSeq < onChainSeq) {
                currentSeq = onChainSeq
                synced = true
            }

            const nextSeq = currentSeq + 1n

            this.sql.exec(
                `INSERT INTO nonces (seq_key, seq) VALUES (?, ?)
         ON CONFLICT(seq_key) DO UPDATE SET seq = ?`,
                key,
                nextSeq.toString(),
                nextSeq.toString(),
            )

            return { seq: currentSeq, synced }
        })

        const { seq, synced } = result as { seq: bigint; synced: boolean }
        return { nonce: (seqKey << 64n) | seq, synced }
    }

    private getDraftForSeqKey(seqKey: string): PendingDraftRow | null {
        const rows = this.sql
            .exec(
                'SELECT seq_key, draft_id, nonce, draft_key, created_at_ms, expires_at_ms FROM pending_drafts WHERE seq_key = ?',
                seqKey,
            )
            .toArray()
        if (rows.length === 0) {
            return null
        }
        return toPendingDraftRow(rows[0] as Record<string, unknown>)
    }

    private deleteExpiredDraftForSeqKey(seqKey: string, nowMs: number): void {
        this.sql.exec(
            'DELETE FROM pending_drafts WHERE seq_key = ? AND expires_at_ms <= ?',
            seqKey,
            nowMs,
        )
    }

    private acquireOrGetDraft(
        seqKey: bigint,
        onChainSeq: bigint,
        options: { draftKey?: string; draftTtlMs: number },
    ): AcquireOrGetDraftResult | AcquireOrGetDraftConflict {
        const key = seqKey.toString()

        const result = this.ctx.storage.transactionSync<
            AcquireOrGetDraftResult | AcquireOrGetDraftConflict
        >(() => {
            const nowMs = Date.now()
            this.deleteExpiredDraftForSeqKey(key, nowMs)

            const existingDraft = this.getDraftForSeqKey(key)
            if (existingDraft !== null) {
                const incomingDraftKey = options.draftKey ?? null
                const existingDraftKey = existingDraft.draft_key
                if (incomingDraftKey !== existingDraftKey) {
                    return {
                        error: 'draft already exists for seqKey with a different draftKey; complete or cancel the active request first',
                        conflictDraftId: existingDraft.draft_id,
                    }
                }
                return {
                    nonce: BigInt(existingDraft.nonce),
                    draftId: existingDraft.draft_id,
                    createdAtMs: existingDraft.created_at_ms,
                    expiresAtMs: existingDraft.expires_at_ms,
                    fromCache: true,
                }
            }

            const nonceRows = this.sql
                .exec('SELECT seq FROM nonces WHERE seq_key = ?', key)
                .toArray()
            let currentSeq = getSeqFromRows(nonceRows)
            if (currentSeq < onChainSeq) {
                currentSeq = onChainSeq
            }

            const nextSeq = currentSeq + 1n
            this.sql.exec(
                `INSERT INTO nonces (seq_key, seq) VALUES (?, ?)
         ON CONFLICT(seq_key) DO UPDATE SET seq = ?`,
                key,
                nextSeq.toString(),
                nextSeq.toString(),
            )

            const createdAtMs = nowMs
            const expiresAtMs = nowMs + options.draftTtlMs
            const draftId = crypto.randomUUID()
            const nonce = (seqKey << 64n) | currentSeq

            this.sql.exec(
                `INSERT INTO pending_drafts (
                    seq_key,
                    draft_id,
                    nonce,
                    draft_key,
                    created_at_ms,
                    expires_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(seq_key) DO UPDATE SET
                    draft_id = excluded.draft_id,
                    nonce = excluded.nonce,
                    draft_key = excluded.draft_key,
                    created_at_ms = excluded.created_at_ms,
                    expires_at_ms = excluded.expires_at_ms`,
                key,
                draftId,
                nonce.toString(),
                options.draftKey ?? null,
                createdAtMs,
                expiresAtMs,
            )

            return {
                nonce,
                draftId,
                createdAtMs,
                expiresAtMs,
                fromCache: false,
            }
        })

        return result
    }

    private markSubmitted(seqKey: bigint, draftId: string): DraftMutationStatus {
        const key = seqKey.toString()

        const status = this.ctx.storage.transactionSync(() => {
            const nowMs = Date.now()
            this.deleteExpiredDraftForSeqKey(key, nowMs)

            const existingDraft = this.getDraftForSeqKey(key)
            if (existingDraft === null) {
                return 'not_found'
            }
            if (existingDraft.draft_id !== draftId) {
                return 'mismatch'
            }

            this.sql.exec('DELETE FROM pending_drafts WHERE seq_key = ?', key)
            return 'cleared'
        })

        return status as DraftMutationStatus
    }

    private cancelDraft(seqKey: bigint, draftId?: string): DraftMutationStatus {
        const key = seqKey.toString()

        const status = this.ctx.storage.transactionSync(() => {
            const nowMs = Date.now()
            this.deleteExpiredDraftForSeqKey(key, nowMs)

            const existingDraft = this.getDraftForSeqKey(key)
            if (existingDraft === null) {
                return 'not_found'
            }
            if (draftId && existingDraft.draft_id !== draftId) {
                return 'mismatch'
            }

            this.sql.exec('DELETE FROM pending_drafts WHERE seq_key = ?', key)
            return 'cleared'
        })

        return status as DraftMutationStatus
    }
}
