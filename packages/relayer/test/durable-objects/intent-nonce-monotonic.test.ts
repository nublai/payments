import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntentNonceDO } from '../../src/durable-objects/intent-nonce.do'

interface SqlResult {
    toArray(): unknown[]
}

class FakeSqlStorage {
    private readonly rows = new Map<string, string>()
    private readonly drafts = new Map<
        string,
        {
            draft_id: string
            nonce: string
            draft_key: string | null
            created_at_ms: number
            expires_at_ms: number
        }
    >()

    exec(query: string, ...args: unknown[]): SqlResult {
        const normalized = query.trim().replace(/\s+/g, ' ')

        if (
            normalized.startsWith('CREATE TABLE IF NOT EXISTS nonces') ||
            normalized.startsWith('CREATE TABLE IF NOT EXISTS pending_drafts') ||
            normalized.startsWith('CREATE INDEX IF NOT EXISTS idx_pending_drafts_expires_at_ms')
        ) {
            return { toArray: () => [] }
        }

        if (normalized.startsWith('SELECT seq FROM nonces WHERE seq_key = ?')) {
            const key = String(args[0])
            const seq = this.rows.get(key)
            return { toArray: () => (seq === undefined ? [] : [{ seq }]) }
        }

        if (normalized.startsWith('SELECT seq_key, seq FROM nonces')) {
            return {
                toArray: () =>
                    Array.from(this.rows.entries()).map(([seq_key, seq]) => ({ seq_key, seq })),
            }
        }

        if (normalized.startsWith('INSERT INTO nonces')) {
            const key = String(args[0])
            const seq = String(args[1])
            this.rows.set(key, seq)
            return { toArray: () => [] }
        }

        if (normalized.startsWith('DELETE FROM nonces WHERE seq_key = ?')) {
            const key = String(args[0])
            this.rows.delete(key)
            return { toArray: () => [] }
        }

        if (
            normalized.startsWith(
                'SELECT seq_key, draft_id, nonce, draft_key, created_at_ms, expires_at_ms FROM pending_drafts WHERE seq_key = ?',
            )
        ) {
            const key = String(args[0])
            const draft = this.drafts.get(key)
            return {
                toArray: () =>
                    draft
                        ? [
                              {
                                  seq_key: key,
                                  draft_id: draft.draft_id,
                                  nonce: draft.nonce,
                                  draft_key: draft.draft_key,
                                  created_at_ms: draft.created_at_ms,
                                  expires_at_ms: draft.expires_at_ms,
                              },
                          ]
                        : [],
            }
        }

        if (
            normalized.startsWith(
                'SELECT seq_key, draft_id, nonce, draft_key, created_at_ms, expires_at_ms FROM pending_drafts',
            )
        ) {
            return {
                toArray: () =>
                    Array.from(this.drafts.entries()).map(([seq_key, draft]) => ({
                        seq_key,
                        draft_id: draft.draft_id,
                        nonce: draft.nonce,
                        draft_key: draft.draft_key,
                        created_at_ms: draft.created_at_ms,
                        expires_at_ms: draft.expires_at_ms,
                    })),
            }
        }

        if (normalized.startsWith('INSERT INTO pending_drafts')) {
            const key = String(args[0])
            this.drafts.set(key, {
                draft_id: String(args[1]),
                nonce: String(args[2]),
                draft_key: args[3] == null ? null : String(args[3]),
                created_at_ms: Number(args[4]),
                expires_at_ms: Number(args[5]),
            })
            return { toArray: () => [] }
        }

        if (
            normalized.startsWith(
                'DELETE FROM pending_drafts WHERE seq_key = ? AND expires_at_ms <= ?',
            )
        ) {
            const key = String(args[0])
            const nowMs = Number(args[1])
            const draft = this.drafts.get(key)
            if (draft && draft.expires_at_ms <= nowMs) {
                this.drafts.delete(key)
            }
            return { toArray: () => [] }
        }

        if (normalized.startsWith('DELETE FROM pending_drafts WHERE seq_key = ?')) {
            const key = String(args[0])
            this.drafts.delete(key)
            return { toArray: () => [] }
        }

        throw new Error(`Unsupported SQL in test stub: ${normalized}`)
    }
}

function createIntentNonceDO(): IntentNonceDO {
    const sql = new FakeSqlStorage()
    const state = {
        storage: {
            sql,
            transactionSync<T>(fn: () => T): T {
                return fn()
            },
        },
    }

    // Construct without DurableObjectBase runtime checks. We only need fetch()
    // and nonce logic methods, all of which rely on ctx.storage/sql.
    const nonceDO = Object.create(IntentNonceDO.prototype) as IntentNonceDO
    ;(nonceDO as unknown as { ctx: typeof state; sql: FakeSqlStorage }).ctx = state
    ;(nonceDO as unknown as { ctx: typeof state; sql: FakeSqlStorage }).sql = sql
    return nonceDO
}

async function doRequest<T>(
    nonceDO: IntentNonceDO,
    path: string,
    body: Record<string, string | number>,
): Promise<T> {
    const response = await doRawRequest(nonceDO, path, body)

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`)
    }

    return (await response.json()) as T
}

async function doRawRequest(
    nonceDO: IntentNonceDO,
    path: string,
    body: Record<string, string | number>,
): Promise<Response> {
    return nonceDO.fetch(
        new Request(`http://do${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    )
}

describe('IntentNonceDO monotonic synced allocation', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('does not duplicate nonces for near-concurrent stale synced acquisitions', async () => {
        const nonceDO = createIntentNonceDO()
        const seqKey = '0'

        await doRequest<{ ok: boolean }>(nonceDO, '/sync', { seqKey, confirmedSeq: '20' })

        const [r1, r2] = await Promise.all([
            doRequest<{ nonce: string; synced: boolean }>(nonceDO, '/acquire_synced', {
                seqKey,
                onChainSeq: '10',
            }),
            doRequest<{ nonce: string; synced: boolean }>(nonceDO, '/acquire_synced', {
                seqKey,
                onChainSeq: '10',
            }),
        ])

        const n1 = BigInt(r1.nonce)
        const n2 = BigInt(r2.nonce)
        const seqs = [n1 & ((1n << 64n) - 1n), n2 & ((1n << 64n) - 1n)].sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
        )

        expect(new Set([n1.toString(), n2.toString()]).size).toBe(2)
        expect(seqs).toEqual([20n, 21n])
        expect(r1.synced).toBe(false)
        expect(r2.synced).toBe(false)
    })

    it('fast-forwards when behind chain and remains monotonic afterward', async () => {
        const nonceDO = createIntentNonceDO()
        const seqKey = '0'

        await doRequest<{ ok: boolean }>(nonceDO, '/sync', { seqKey, confirmedSeq: '3' })

        const first = await doRequest<{ nonce: string; synced: boolean }>(
            nonceDO,
            '/acquire_synced',
            {
                seqKey,
                onChainSeq: '8',
            },
        )
        const second = await doRequest<{ nonce: string; synced: boolean }>(
            nonceDO,
            '/acquire_synced',
            {
                seqKey,
                onChainSeq: '8',
            },
        )

        expect(BigInt(first.nonce)).toBe(8n)
        expect(first.synced).toBe(true)
        expect(BigInt(second.nonce)).toBe(9n)
        expect(second.synced).toBe(false)
    })

    it('replays active draft when acquire_or_get_draft is retried with same draft key', async () => {
        const nonceDO = createIntentNonceDO()
        const seqKey = '0'

        const first = await doRequest<{
            nonce: string
            draftId: string
            createdAtMs: number
            expiresAtMs: number
            fromCache: boolean
        }>(nonceDO, '/acquire_or_get_draft', {
            seqKey,
            onChainSeq: '0',
            draftKey: 'first',
        })

        const second = await doRequest<{
            nonce: string
            draftId: string
            createdAtMs: number
            expiresAtMs: number
            fromCache: boolean
        }>(nonceDO, '/acquire_or_get_draft', {
            seqKey,
            onChainSeq: '0',
            draftKey: 'first',
        })

        expect(first.fromCache).toBe(false)
        expect(second.fromCache).toBe(true)
        expect(second.nonce).toBe(first.nonce)
        expect(second.draftId).toBe(first.draftId)
        expect(second.createdAtMs).toBe(first.createdAtMs)
        expect(second.expiresAtMs).toBe(first.expiresAtMs)
    })

    it('rejects acquire_or_get_draft when a different draft key is already active', async () => {
        const nonceDO = createIntentNonceDO()
        const seqKey = '0'

        const first = await doRequest<{ draftId: string }>(nonceDO, '/acquire_or_get_draft', {
            seqKey,
            onChainSeq: '0',
            draftKey: 'first',
        })

        const conflict = await doRawRequest(nonceDO, '/acquire_or_get_draft', {
            seqKey,
            onChainSeq: '0',
            draftKey: 'second',
        })
        const conflictBody = (await conflict.json()) as { error: string; conflictDraftId: string }

        expect(conflict.status).toBe(409)
        expect(conflictBody.error).toContain('different draftKey')
        expect(conflictBody.conflictDraftId).toBe(first.draftId)
    })

    it('clears draft on mark_submitted and advances nonce on next prepare', async () => {
        const nonceDO = createIntentNonceDO()
        const seqKey = '0'

        const first = await doRequest<{ nonce: string; draftId: string; fromCache: boolean }>(
            nonceDO,
            '/acquire_or_get_draft',
            {
                seqKey,
                onChainSeq: '0',
            },
        )

        const markSubmitted = await doRequest<{ ok: boolean; status: string }>(
            nonceDO,
            '/mark_submitted',
            {
                seqKey,
                draftId: first.draftId,
            },
        )

        const second = await doRequest<{ nonce: string; draftId: string; fromCache: boolean }>(
            nonceDO,
            '/acquire_or_get_draft',
            {
                seqKey,
                onChainSeq: '0',
            },
        )

        expect(markSubmitted.ok).toBe(true)
        expect(markSubmitted.status).toBe('cleared')
        expect(second.fromCache).toBe(false)
        expect(BigInt(second.nonce)).toBe(BigInt(first.nonce) + 1n)
        expect(second.draftId).not.toBe(first.draftId)
    })

    it('expires draft by TTL and allocates a fresh draft without rewinding', async () => {
        const nonceDO = createIntentNonceDO()
        const seqKey = '0'
        const dateNowSpy = vi.spyOn(Date, 'now')

        dateNowSpy.mockReturnValueOnce(1_000_000)
        const first = await doRequest<{ nonce: string; draftId: string; fromCache: boolean }>(
            nonceDO,
            '/acquire_or_get_draft',
            {
                seqKey,
                onChainSeq: '0',
                draftTtlMs: 60_000,
            },
        )

        // Move beyond min TTL bound to expire the first draft
        dateNowSpy.mockReturnValueOnce(1_061_000)
        const second = await doRequest<{ nonce: string; draftId: string; fromCache: boolean }>(
            nonceDO,
            '/acquire_or_get_draft',
            {
                seqKey,
                onChainSeq: '0',
                draftTtlMs: 60_000,
            },
        )

        expect(first.fromCache).toBe(false)
        expect(second.fromCache).toBe(false)
        expect(BigInt(second.nonce)).toBe(BigInt(first.nonce) + 1n)
        expect(second.draftId).not.toBe(first.draftId)
    })
})
