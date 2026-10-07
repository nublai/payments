/**
 * SignerPoolDO - Stateless coordinator for the signer pool
 *
 * SignerPoolDO coordinates transaction routing across multiple SignerDOs:
 * - Queries all signers for capacity in parallel
 * - Selects the best signer (highest capacity with shuffle for tie-breaking)
 * - Routes transactions with retry logic on capacity rejection
 * - Coordinates maintenance across all signers
 *
 * This DO is stateless - it reads configuration from environment variables.
 * Uses SQLite storage class for consistency with other DOs.
 *
 * DO naming convention: "pool-{chainId}"
 * Example: "pool-31337" for local chain
 */

import { DurableObject } from 'cloudflare:workers'
import type { Hex } from 'viem'

import type { Env } from '../types/env'
import { getErrorMessage } from '../lib/logger'
import type {
    RelayTransaction,
    CapacityInfo,
    IndexedCapacityInfo,
    SendResult,
    MaintenanceResult,
    SignerMaintenanceResult,
    SignerError,
    ExecuteIntentTransaction,
} from '../types/pool'
import { selectSignerForEoa } from '../lib/pool-utils'
import { poolSendBroadcastAttempted, signerSendDisposition } from './signer-pool-send'
import {
    consumeRateLimit,
    peekRateLimit,
    releaseRateLimit,
    upgradeRateBuckets,
    type UpgradeRateAction,
    type UpgradeRateKind,
} from '../rpc/methods/shared/upgrade-rate-limit'

class SignerPoolSendError extends Error {
    broadcastAttempted: boolean

    constructor(message: string, broadcastAttempted: boolean) {
        super(message)
        this.name = 'SignerPoolSendError'
        this.broadcastAttempted = broadcastAttempted
    }
}

// Default configuration
const DEFAULT_SIGNER_COUNT = 1
const DEFAULT_MAX_PENDING_TOTAL = 1000

/**
 * SignerPoolDO - Stateless coordinator (SQLite-backed for consistency)
 */
export class SignerPoolDO extends DurableObject<Env> {
    // Fallback for local dev where ctx.id.name is undefined
    private poolNameOverride: string | null = null
    private upgradeRateSchemaReady = false

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        // Access sql to initialize as SQLite-backed DO
        void ctx.storage.sql
    }
    /**
     * HTTP handler for SignerPoolDO endpoints
     */
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const poolNameParam = url.searchParams.get('poolName')
        if (poolNameParam) {
            this.poolNameOverride = poolNameParam
        }

        try {
            switch (url.pathname) {
                case '/send': {
                    if (request.method !== 'POST') {
                        return new Response('Method not allowed', { status: 405 })
                    }
                    const tx = (await request.json()) as RelayTransaction
                    const result = await this.sendTransaction(tx)
                    return Response.json(result)
                }

                case '/status': {
                    const status = await this.getPoolStatus()
                    return Response.json(status)
                }

                case '/maintenance': {
                    if (request.method !== 'POST') {
                        return new Response('Method not allowed', { status: 405 })
                    }
                    const result = await this.handleMaintenance()
                    return Response.json(result)
                }

                case '/upgrade-rate-limit': {
                    if (request.method !== 'POST') {
                        return new Response('Method not allowed', { status: 405 })
                    }
                    const body = (await request.json()) as {
                        action?: UpgradeRateAction
                        kind?: UpgradeRateKind
                        chainId?: number
                        account?: string
                        ip?: string
                        identity?: string
                    }
                    const result = this.consumeUpgradeRateLimit(body)
                    return Response.json(result)
                }

                default:
                    return new Response('Not found', { status: 404 })
            }
        } catch (error) {
            const message = getErrorMessage(error)
            if (url.pathname === '/send') {
                const broadcastAttempted =
                    error instanceof SignerPoolSendError ? error.broadcastAttempted : false
                return Response.json({ error: message, broadcastAttempted }, { status: 500 })
            }
            return Response.json({ error: message } as SignerError, { status: 500 })
        }
    }

    /**
     * Sliding-window limit for account upgrade prepare/broadcast.
     * State lives here because SignerPoolDO is already bound on every chain.
     * `peek` does not consume a slot. `reserve` and a missing action commit
     * every bucket from upgradeRateBuckets, including an IPv6 /56, in one
     * transaction. `release`
     * returns a reservation that never reached eth_sendRawTransaction.
     */
    private consumeUpgradeRateLimit(body: {
        action?: UpgradeRateAction
        kind?: UpgradeRateKind
        chainId?: number
        account?: string
        ip?: string
        identity?: string
        reservedAt?: number
    }): { allowed: boolean; reservedAt?: number } {
        const knownAction =
            body.action === undefined ||
            body.action === 'peek' ||
            body.action === 'commit' ||
            body.action === 'reserve' ||
            body.action === 'release'
        if (
            (body.kind !== 'prepare' && body.kind !== 'upgrade') ||
            typeof body.chainId !== 'number' ||
            !Number.isInteger(body.chainId) ||
            typeof body.account !== 'string' ||
            typeof body.ip !== 'string' ||
            (body.identity !== undefined && typeof body.identity !== 'string') ||
            (body.reservedAt !== undefined && !Number.isInteger(body.reservedAt)) ||
            !knownAction
        ) {
            return { allowed: false }
        }

        const action = body.action ?? 'commit'
        const nowSeconds = Math.floor(Date.now() / 1000)
        const buckets = upgradeRateBuckets({
            kind: body.kind,
            chainId: body.chainId,
            account: body.account,
            ip: body.ip,
            identity: body.identity,
        })
        const sql = this.ensureUpgradeRateSchema()

        return this.ctx.storage.transactionSync(() => {
            const store = new Map<string, number>()
            for (const bucket of buckets) {
                const earliest = nowSeconds - bucket.windowSeconds
                const rows = sql
                    .exec<{ window_start: number; hits: number }>(
                        `SELECT window_start, hits FROM upgrade_rate_windows
                         WHERE bucket_key = ? AND window_start > ?`,
                        `${bucket.key}#sec`,
                        earliest,
                    )
                    .toArray()
                for (const row of rows) {
                    if (!Number.isFinite(row.hits) || !Number.isFinite(row.window_start)) continue
                    store.set(`${bucket.key}#${row.window_start}`, row.hits)
                }
            }

            if (action === 'release') {
                const reservedAt = body.reservedAt ?? nowSeconds
                releaseRateLimit(store, buckets, reservedAt)
                for (const bucket of buckets) {
                    const hits = store.get(`${bucket.key}#${reservedAt}`) ?? 0
                    const sqlKey = `${bucket.key}#sec`
                    if (hits <= 0) {
                        sql.exec(
                            `DELETE FROM upgrade_rate_windows
                             WHERE bucket_key = ? AND window_start = ?`,
                            sqlKey,
                            reservedAt,
                        )
                    } else {
                        sql.exec(
                            `INSERT INTO upgrade_rate_windows (bucket_key, window_start, hits)
                             VALUES (?, ?, ?)
                             ON CONFLICT(bucket_key, window_start) DO UPDATE SET hits = excluded.hits`,
                            sqlKey,
                            reservedAt,
                            hits,
                        )
                    }
                }
                return { allowed: true }
            }

            const decision =
                action === 'peek'
                    ? peekRateLimit(store, buckets, nowSeconds)
                    : consumeRateLimit(store, buckets, nowSeconds)
            if (!decision.allowed || action === 'peek') {
                return { allowed: decision.allowed }
            }

            for (const [id, hits] of store) {
                const splitAt = id.lastIndexOf('#')
                if (splitAt < 0) continue
                const second = Number(id.slice(splitAt + 1))
                if (!Number.isInteger(second)) continue
                sql.exec(
                    `INSERT INTO upgrade_rate_windows (bucket_key, window_start, hits)
                     VALUES (?, ?, ?)
                     ON CONFLICT(bucket_key, window_start) DO UPDATE SET hits = excluded.hits`,
                    `${id.slice(0, splitAt)}#sec`,
                    second,
                    hits,
                )
            }

            sql.exec(
                'DELETE FROM upgrade_rate_windows WHERE window_start <= ?',
                nowSeconds - 3600,
            )
            return action === 'reserve' ? { allowed: true, reservedAt: nowSeconds } : { allowed: true }
        })
    }

    private ensureUpgradeRateSchema(): SqlStorage {
        const sql = this.ctx.storage.sql
        if (!this.upgradeRateSchemaReady) {
            sql.exec(`
                CREATE TABLE IF NOT EXISTS upgrade_rate_windows (
                    bucket_key TEXT NOT NULL,
                    window_start INTEGER NOT NULL,
                    hits INTEGER NOT NULL,
                    PRIMARY KEY (bucket_key, window_start)
                )
            `)
            this.upgradeRateSchemaReady = true
        }
        return sql
    }

    /**
     * Get pool configuration from environment
     */
    private getConfig(): {
        numSigners: number
        chainId: number
        maxPendingTotal: number
    } {
        const chainId = this.getChainIdFromName()
        return {
            numSigners: parseInt(this.env.RELAYER_COUNT ?? String(DEFAULT_SIGNER_COUNT), 10),
            chainId,
            maxPendingTotal: parseInt(
                this.env.MAX_PENDING_TOTAL ?? String(DEFAULT_MAX_PENDING_TOTAL),
                10,
            ),
        }
    }

    private getChainIdFromName(): number {
        const name = this.ctx.id.name ?? this.poolNameOverride
        if (!name) {
            throw new Error('SignerPoolDO name unavailable; expected pool-{chainId}')
        }
        const parts = name.split('-')
        if (parts.length !== 2 || parts[0] !== 'pool') {
            throw new Error(`Invalid pool DO name: ${name}`)
        }
        const chainId = parseInt(parts[1], 10)
        if (!Number.isFinite(chainId)) {
            throw new Error(`Invalid chainId in pool DO name: ${name}`)
        }
        return chainId
    }

    /**
     * Get all signer capacities in parallel
     * Individual signer failures are caught and marked as errors
     */
    private async getAllCapacities(): Promise<IndexedCapacityInfo[]> {
        const { numSigners, chainId } = this.getConfig()

        const promises = Array.from({ length: numSigners }, async (_, i) => {
            const signerName = `signer-${chainId}-${i}`
            try {
                const signerId = this.env.SIGNER.idFromName(signerName)
                const signer = this.env.SIGNER.get(signerId)

                // Include signerName query param for local dev where ctx.id.name is undefined
                const response = await signer.fetch(`http://do/capacity?signerName=${signerName}`)
                if (!response.ok) {
                    const error = (await response.json()) as SignerError
                    console.error(`Signer ${i} capacity check failed:`, error)
                    return {
                        index: i,
                        capacity: 0,
                        pending: 0,
                        address: null,
                        error: true,
                    }
                }

                const info = (await response.json()) as CapacityInfo
                return { index: i, ...info, error: false }
            } catch (err) {
                // Individual signer failure doesn't fail entire selection
                console.error(`Signer ${i} unreachable:`, err)
                return {
                    index: i,
                    capacity: 0,
                    pending: 0,
                    address: null,
                    error: true,
                }
            }
        })

        return Promise.all(promises)
    }

    /**
     * Select the best signer based on capacity
     * Returns sorted list of candidates (highest capacity first)
     */
    private selectCandidates(capacities: IndexedCapacityInfo[]): IndexedCapacityInfo[] {
        // Filter to signers with available capacity and no errors
        const available = capacities.filter((c) => c.capacity > 0 && !c.error)

        if (available.length === 0) {
            return []
        }

        // Shuffle for fair tie-breaking among signers with same capacity
        this.shuffle(available)

        // Sort by capacity descending (stable sort preserves shuffle order for ties)
        return available.sort((a, b) => b.capacity - a.capacity)
    }

    /**
     * Fisher-Yates shuffle for fair tie-breaking
     */
    private shuffle<T>(array: T[]): void {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[array[i], array[j]] = [array[j], array[i]]
        }
    }

    /**
     * Send a transaction via the pool
     * Implements retry logic: if selected signer rejects, try next candidate
     *
     * For execute-intent transactions, uses per-EOA routing to ensure
     * transactions for the same EOA go to the same signer (prevents nonce conflicts).
     */
    async sendTransaction(tx: RelayTransaction): Promise<SendResult> {
        const { chainId, numSigners, maxPendingTotal } = this.getConfig()

        // Get all capacities in parallel
        const capacities = await this.getAllCapacities()

        // Check global backpressure
        const totalPending = capacities.reduce((sum, c) => sum + c.pending, 0)
        if (totalPending >= maxPendingTotal) {
            throw new Error(
                `Pool at global capacity: ${totalPending}/${maxPendingTotal} pending transactions`,
            )
        }

        // Get sorted candidates
        const candidates = this.selectCandidates(capacities)
        if (candidates.length === 0) {
            throw new Error('No signers available - all at capacity or in error state')
        }

        // For execute-intent transactions, use per-EOA routing
        // This ensures transactions for the same EOA go to the same signer
        if (tx.type === 'execute-intent') {
            const intentTx = tx as ExecuteIntentTransaction
            const preferredIndex = selectSignerForEoa(intentTx.intent.eoa, numSigners)

            // Reorder candidates to try the preferred signer first (if available)
            const preferredIdx = candidates.findIndex((c) => c.index === preferredIndex)
            if (preferredIdx > 0) {
                const [preferred] = candidates.splice(preferredIdx, 1)
                candidates.unshift(preferred)
            }
        }

        // Try each candidate until one succeeds. Retry only when that attempt
        // returned before eth_sendRawTransaction. A later candidate cannot
        // clear a slot that an earlier candidate already submitted.
        const attempts: Array<{ broadcastAttempted: boolean; message?: string }> = []
        let lastMessage = 'No signers available - all at capacity'

        for (const candidate of candidates) {
            const signerName = `signer-${chainId}-${candidate.index}`
            try {
                const signerId = this.env.SIGNER.idFromName(signerName)
                const signer = this.env.SIGNER.get(signerId)

                // Include signerName query param for local dev where ctx.id.name is undefined
                const response = await signer.fetch(`http://do/send?signerName=${signerName}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(tx),
                })

                if (response.ok) {
                    const result = (await response.json()) as SendResult
                    return result
                }

                // An unreadable body is treated as a send: the slot stays reserved.
                let error: SignerError & { broadcastAttempted?: boolean }
                try {
                    error = (await response.json()) as SignerError & { broadcastAttempted?: boolean }
                } catch {
                    throw new SignerPoolSendError('unreadable signer error', true)
                }
                const attempt = {
                    broadcastAttempted: error.broadcastAttempted !== false,
                    message: error.error,
                }
                attempts.push(attempt)
                if (signerSendDisposition(attempt) === 'retry') {
                    lastMessage = error.error
                    continue
                }
                throw new SignerPoolSendError(error.error, true)
            } catch (err) {
                if (
                    err instanceof SignerPoolSendError &&
                    signerSendDisposition({
                        broadcastAttempted: err.broadcastAttempted,
                        message: err.message,
                    }) === 'retry'
                ) {
                    lastMessage = err.message
                    continue
                }
                if (err instanceof SignerPoolSendError) throw err
                // The attempt has no before-send flag. Keep the reservation.
                throw new SignerPoolSendError(getErrorMessage(err), true)
            }
        }

        throw new SignerPoolSendError(lastMessage, poolSendBroadcastAttempted(attempts))
    }

    /**
     * Get pool status - all signer capacities
     */
    async getPoolStatus(): Promise<{
        chainId: number
        signerCount: number
        totalCapacity: number
        totalPending: number
        signers: IndexedCapacityInfo[]
    }> {
        const { chainId, numSigners } = this.getConfig()
        const capacities = await this.getAllCapacities()

        const totalCapacity = capacities.reduce((sum, c) => sum + c.capacity, 0)
        const totalPending = capacities.reduce((sum, c) => sum + c.pending, 0)

        return {
            chainId,
            signerCount: numSigners,
            totalCapacity,
            totalPending,
            signers: capacities,
        }
    }

    /**
     * Run maintenance on all signers
     */
    async handleMaintenance(): Promise<MaintenanceResult> {
        const { numSigners, chainId } = this.getConfig()

        const results = await Promise.all(
            Array.from({ length: numSigners }, async (_, i) => {
                const signerName = `signer-${chainId}-${i}`
                try {
                    const signerId = this.env.SIGNER.idFromName(signerName)
                    const signer = this.env.SIGNER.get(signerId)

                    // Include signerName query param for local dev where ctx.id.name is undefined
                    const response = await signer.fetch(
                        `http://do/maintenance?signerName=${signerName}`,
                        {
                            method: 'POST',
                        },
                    )

                    if (!response.ok) {
                        const error = (await response.json()) as SignerError
                        return {
                            index: i,
                            address: '0x' as Hex,
                            staleTransactions: 0,
                            confirmedTransactions: 0,
                            failedTransactions: 0,
                            stuckTransactions: 0,
                            balance: '0',
                            paused: true,
                            error: error.error,
                        }
                    }

                    return (await response.json()) as SignerMaintenanceResult
                } catch (err) {
                    console.error(`Signer ${i} maintenance failed:`, err)
                    return {
                        index: i,
                        address: '0x' as Hex,
                        staleTransactions: 0,
                        confirmedTransactions: 0,
                        failedTransactions: 0,
                        stuckTransactions: 0,
                        balance: '0',
                        paused: true,
                        error: err instanceof Error ? err.message : 'Unknown error',
                    }
                }
            }),
        )

        return { signers: results }
    }
}
