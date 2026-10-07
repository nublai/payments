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
import { createPublicClient, http, type Address, type Hex } from 'viem'

import type { Env } from '../types/env'
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
import { getErrorMessage, logger } from '../lib/logger'
import { getChainRpcUrl } from '../lib/multi-chain-client'
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
import {
    PAID_UPGRADE_GAS_HOLD,
    paidUpgradeDailyGasBudget,
    paidUpgradeGlobalLimit,
    paidUpgradeRateBuckets,
    paidUpgradeReceiptOutcome,
} from '../rpc/methods/shared/paid-upgrade'

function parseTxHash(value: unknown): Hex | undefined {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return undefined
    return value as Hex
}

function isTransactionMissing(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const name = 'name' in error && typeof error.name === 'string' ? error.name : ''
    return name === 'TransactionNotFoundError' || name === 'TransactionReceiptNotFoundError'
}

function parseGasUnits(value: unknown): number | undefined {
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return undefined
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined
    return parsed
}

class SignerPoolSendError extends Error {
    broadcastAttempted: boolean
    code?: SignerError['code']

    constructor(
        message: string,
        broadcastAttempted: boolean,
        code?: SignerError['code'],
    ) {
        super(message)
        this.name = 'SignerPoolSendError'
        this.broadcastAttempted = broadcastAttempted
        this.code = code
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
                        action?:
                            | UpgradeRateAction
                            | 'reserve-gas'
                            | 'release-gas'
                            | 'settle-gas'
                            | 'enqueue-receipt'
                            | 'reconcile-receipt'
                            | 'reconcile-pending'
                            | 'track-replacement'
                        kind?: UpgradeRateKind | 'paid-upgrade'
                        chainId?: number
                        account?: string
                        ip?: string
                        identity?: string
                        gas?: string
                        hold?: string
                        failure?: boolean
                        reservedAt?: number
                        txHash?: string
                        priorHash?: string
                        nonce?: number
                        signerName?: string
                        found?: boolean
                        nonceConsumed?: boolean
                    }
                    if (body.kind === 'paid-upgrade' && body.action === 'reconcile-pending') {
                        await this.reconcilePendingReceipts()
                        return Response.json({ allowed: true })
                    }
                    if (
                        body.kind === 'paid-upgrade' &&
                        (body.action === 'reserve-gas' ||
                            body.action === 'release-gas' ||
                            body.action === 'settle-gas' ||
                            body.action === 'enqueue-receipt' ||
                            body.action === 'reconcile-receipt' ||
                            body.action === 'track-replacement')
                    ) {
                        const result = this.consumePaidUpgradeGas(body)
                        if (body.action === 'enqueue-receipt' && result.allowed) {
                            await this.schedulePaidUpgradeReconcile()
                        }
                        return Response.json(result)
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
                const code = error instanceof SignerPoolSendError ? error.code : undefined
                return Response.json(
                    { error: message, broadcastAttempted, ...(code ? { code } : {}) },
                    { status: 500 },
                )
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
        action?:
            | UpgradeRateAction
            | 'reserve-gas'
            | 'release-gas'
            | 'settle-gas'
            | 'enqueue-receipt'
            | 'reconcile-receipt'
            | 'reconcile-pending'
        kind?: UpgradeRateKind | 'paid-upgrade'
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
        const paidUpgrade = body.kind === 'paid-upgrade'
        if (
            (body.kind !== 'prepare' && body.kind !== 'upgrade' && !paidUpgrade) ||
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
        let globalLimit = 0
        if (paidUpgrade) {
            try {
                globalLimit = paidUpgradeGlobalLimit(this.env)
            } catch {
                return { allowed: false }
            }
        }
        const buckets = paidUpgrade
            ? paidUpgradeRateBuckets({
                  chainId: body.chainId,
                  account: body.account,
                  ip: body.ip,
                  globalLimit,
                  includeGlobal: action === 'reserve' || action === 'release',
              })
            : upgradeRateBuckets({
                  kind: body.kind as UpgradeRateKind,
                  chainId: body.chainId,
                  account: body.account,
                  ip: body.ip as string,
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

    private consumePaidUpgradeGas(body: {
        action?: string
        chainId?: number
        gas?: string
        hold?: string
        failure?: boolean
        txHash?: string
        priorHash?: string
        nonce?: number
        signerName?: string
        found?: boolean
        nonceConsumed?: boolean
    }): {
        allowed: boolean
        gas?: number
        held?: number
        failures?: number
        overBudget?: boolean
    } {
        if (typeof body.chainId !== 'number' || !Number.isInteger(body.chainId)) {
            return { allowed: false }
        }
        let budget: bigint
        try {
            budget = paidUpgradeDailyGasBudget(this.env)
        } catch {
            return { allowed: false }
        }
        const dayStart = Math.floor(Date.now() / 1000 / 86_400) * 86_400
        const sql = this.ensureUpgradeRateSchema()
        const txHash = parseTxHash(body.txHash)

        if (body.action === 'enqueue-receipt') {
            if (!txHash) return { allowed: false }
            return this.ctx.storage.transactionSync(() => {
                const existing = this.pendingReceipt(sql, txHash)
                if (!existing) {
                    sql.exec(
                        `INSERT INTO paid_upgrade_pending_receipt
                            (tx_hash, chain_id, status, enqueued_at, nonce, signer_name)
                         VALUES (?, ?, 'pending', ?, ?, ?)`,
                        txHash,
                        body.chainId,
                        Math.floor(Date.now() / 1000),
                        this.receiptNonce(body.nonce),
                        this.receiptSigner(body.signerName),
                    )
                }
                return { allowed: true }
            })
        }

        if (body.action === 'track-replacement') {
            const priorHash = parseTxHash(body.priorHash)
            if (!txHash || !priorHash) return { allowed: false }
            if (!Number.isInteger(body.nonce) || body.nonce === undefined || body.nonce < 0) {
                return { allowed: false }
            }
            const signerName = this.receiptSigner(body.signerName)
            if (!signerName) return { allowed: false }
            return this.ctx.storage.transactionSync(() => {
                const now = Math.floor(Date.now() / 1000)
                const prior = this.pendingReceipt(sql, priorHash)
                if (prior) {
                    sql.exec(
                        `UPDATE paid_upgrade_pending_receipt
                         SET nonce = ?, signer_name = ?
                         WHERE tx_hash = ? AND nonce IS NULL`,
                        body.nonce,
                        signerName,
                        priorHash,
                    )
                } else {
                    sql.exec(
                        `INSERT INTO paid_upgrade_pending_receipt
                            (tx_hash, chain_id, status, enqueued_at, nonce, signer_name)
                         VALUES (?, ?, 'pending', ?, ?, ?)`,
                        priorHash,
                        body.chainId,
                        now,
                        body.nonce,
                        signerName,
                    )
                }
                if (!this.pendingReceipt(sql, txHash)) {
                    sql.exec(
                        `INSERT INTO paid_upgrade_pending_receipt
                            (tx_hash, chain_id, status, enqueued_at, nonce, signer_name)
                         VALUES (?, ?, 'pending', ?, ?, ?)`,
                        txHash,
                        body.chainId,
                        now,
                        body.nonce,
                        signerName,
                    )
                }
                const books = this.readGasBooks(sql, dayStart)
                return { allowed: true, gas: books.gasSpent, held: books.held, failures: books.failures }
            })
        }

        if (body.action === 'reconcile-receipt') {
            if (!txHash) return { allowed: false }
            if (body.found === true) {
                const gas = parseGasUnits(body.gas)
                if (gas === undefined) return { allowed: false }
                return this.applyPaidUpgradeSettle(sql, {
                    budget,
                    dayStart,
                    gas,
                    hold: Number(PAID_UPGRADE_GAS_HOLD),
                    failure: body.failure === true,
                    txHash,
                    chainId: body.chainId,
                })
            }
            if (body.found === false) {
                return this.applyPaidUpgradeRelease(sql, {
                    dayStart,
                    txHash,
                    hold: Number(PAID_UPGRADE_GAS_HOLD),
                    nonceConsumed: body.nonceConsumed === true,
                })
            }
            return { allowed: false }
        }

        const gas = parseGasUnits(body.gas)
        if (gas === undefined) return { allowed: false }
        const hold = body.action === 'settle-gas' ? parseGasUnits(body.hold) : gas
        if (hold === undefined) return { allowed: false }

        if (body.action === 'settle-gas') {
            return this.applyPaidUpgradeSettle(sql, {
                budget,
                dayStart,
                gas,
                hold,
                failure: body.failure === true,
                txHash,
                chainId: body.chainId,
            })
        }

        return this.ctx.storage.transactionSync(() => {
            const books = this.readGasBooks(sql, dayStart)
            let { gasSpent, heldGas, failures } = books
            if (body.action === 'reserve-gas') {
                // The signed gas limit cannot exceed this reservation, and the
                // reservation cannot exceed the approved hold. spent + held +
                // this reservation must still fit in the daily budget.
                if (
                    BigInt(gas) > PAID_UPGRADE_GAS_HOLD ||
                    BigInt(gasSpent) + BigInt(heldGas) + BigInt(gas) > budget
                ) {
                    return { allowed: false, gas: gasSpent, held: heldGas, failures }
                }
                heldGas += gas
            } else if (body.action === 'release-gas') {
                heldGas = Math.max(0, heldGas - gas)
            } else {
                return { allowed: false }
            }
            this.writeGasBooks(sql, dayStart, gasSpent, heldGas, failures)
            return { allowed: true, gas: gasSpent, held: heldGas, failures }
        })
    }

    /**
     * Record gas that was already spent. A repeat settle for the same tx hash
     * does not add again. The accounted amount is at most the reserved hold
     * and at most the room left in the daily budget, so spent + held cannot
     * pass the budget.
     */
    private applyPaidUpgradeSettle(
        sql: SqlStorage,
        input: {
            budget: bigint
            dayStart: number
            gas: number
            hold: number
            failure: boolean
            txHash?: Hex
            chainId: number
        },
    ): {
        allowed: boolean
        gas?: number
        held?: number
        failures?: number
        overBudget?: boolean
    } {
        return this.ctx.storage.transactionSync(() => {
            const books = this.readGasBooks(sql, input.dayStart)
            let { gasSpent, heldGas, failures } = books
            const prior = input.txHash ? this.pendingReceipt(sql, input.txHash) : undefined
            if (prior?.status === 'settled') {
                return { allowed: true, gas: gasSpent, held: heldGas, failures }
            }
            const holdToRelease = prior?.status === 'released' ? 0 : input.hold
            heldGas = Math.max(0, heldGas - holdToRelease)
            const holdCap =
                input.hold > 0 && input.hold < Number(PAID_UPGRADE_GAS_HOLD)
                    ? input.hold
                    : Number(PAID_UPGRADE_GAS_HOLD)
            let accounted = Math.min(input.gas, holdCap)
            const room = Number(input.budget - BigInt(gasSpent) - BigInt(heldGas))
            if (accounted > room) accounted = Math.max(0, room)
            gasSpent += accounted
            if (input.failure) failures += 1
            const overBudget = BigInt(gasSpent) + BigInt(heldGas) > input.budget
            this.writeGasBooks(sql, input.dayStart, gasSpent, heldGas, failures)
            if (input.txHash) {
                sql.exec(
                    `INSERT INTO paid_upgrade_pending_receipt (tx_hash, chain_id, status, enqueued_at)
                     VALUES (?, ?, 'settled', ?)
                     ON CONFLICT(tx_hash) DO UPDATE SET status = 'settled'`,
                    input.txHash,
                    input.chainId,
                    Math.floor(Date.now() / 1000),
                )
                this.closePaidUpgradeGroup(sql, input.txHash, 'settled')
            }
            return {
                allowed: !overBudget,
                overBudget,
                gas: gasSpent,
                held: heldGas,
                failures,
            }
        })
    }

    private applyPaidUpgradeRelease(
        sql: SqlStorage,
        input: { dayStart: number; txHash: Hex; hold: number; nonceConsumed?: boolean },
    ): { allowed: boolean; gas?: number; held?: number; failures?: number } {
        return this.ctx.storage.transactionSync(() => {
            const books = this.readGasBooks(sql, input.dayStart)
            let { gasSpent, heldGas, failures } = books
            const prior = this.pendingReceipt(sql, input.txHash)
            if (!prior || prior.status !== 'pending') {
                return { allowed: true, gas: gasSpent, held: heldGas, failures }
            }
            // Another hash for this nonce is still in flight. Dropping the
            // missing hash must not give the hold back.
            if (this.hasPendingSibling(sql, input.txHash)) {
                sql.exec(
                    `UPDATE paid_upgrade_pending_receipt SET status = 'dropped' WHERE tx_hash = ?`,
                    input.txHash,
                )
                return { allowed: true, gas: gasSpent, held: heldGas, failures }
            }
            // A nonce we are still watching can be replaced after this hash
            // disappears. Release only once something else has consumed it.
            if (prior.nonce != null && input.nonceConsumed !== true) {
                return { allowed: true, gas: gasSpent, held: heldGas, failures }
            }
            heldGas = Math.max(0, heldGas - input.hold)
            this.writeGasBooks(sql, input.dayStart, gasSpent, heldGas, failures)
            sql.exec(
                `UPDATE paid_upgrade_pending_receipt SET status = 'released' WHERE tx_hash = ?`,
                input.txHash,
            )
            return { allowed: true, gas: gasSpent, held: heldGas, failures }
        })
    }

    private readGasBooks(
        sql: SqlStorage,
        dayStart: number,
    ): { gasSpent: number; heldGas: number; failures: number } {
        const rows = sql
            .exec<{ day_start: number; gas: number; held: number; failures: number }>(
                `SELECT day_start, gas, held, failures FROM paid_upgrade_gas_budget WHERE id = 1`,
            )
            .toArray()
        const row = rows[0]
        if (!row || row.day_start !== dayStart) {
            return { gasSpent: 0, heldGas: 0, failures: 0 }
        }
        return { gasSpent: row.gas, heldGas: row.held, failures: row.failures }
    }

    private writeGasBooks(
        sql: SqlStorage,
        dayStart: number,
        gasSpent: number,
        heldGas: number,
        failures: number,
    ): void {
        sql.exec(
            `INSERT INTO paid_upgrade_gas_budget (id, day_start, gas, held, failures)
             VALUES (1, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                day_start = excluded.day_start,
                gas = excluded.gas,
                held = excluded.held,
                failures = excluded.failures`,
            dayStart,
            gasSpent,
            heldGas,
            failures,
        )
    }

    private pendingReceipt(
        sql: SqlStorage,
        txHash: string,
    ): { status: string; nonce: number | null; signer_name: string | null; chain_id: number } | undefined {
        return sql
            .exec<{
                status: string
                nonce: number | null
                signer_name: string | null
                chain_id: number
            }>(
                `SELECT status, nonce, signer_name, chain_id FROM paid_upgrade_pending_receipt WHERE tx_hash = ?`,
                txHash,
            )
            .toArray()[0]
    }

    private receiptNonce(value: unknown): number | null {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
        return value
    }

    private receiptSigner(value: unknown): string | null {
        if (typeof value !== 'string') return null
        const trimmed = value.trim()
        return trimmed.length > 0 ? trimmed : null
    }

    private hasPendingSibling(sql: SqlStorage, txHash: string): boolean {
        const row = this.pendingReceipt(sql, txHash)
        if (!row || row.nonce == null || !row.signer_name) return false
        const siblings = sql
            .exec<{ tx_hash: string }>(
                `SELECT tx_hash FROM paid_upgrade_pending_receipt
                 WHERE chain_id = ? AND nonce = ? AND signer_name = ?
                   AND status = 'pending' AND tx_hash != ?`,
                row.chain_id,
                row.nonce,
                row.signer_name,
                txHash,
            )
            .toArray()
        return siblings.length > 0
    }

    private closePaidUpgradeGroup(sql: SqlStorage, txHash: string, status: 'settled' | 'released'): void {
        const row = this.pendingReceipt(sql, txHash)
        if (!row || row.nonce == null || !row.signer_name) return
        sql.exec(
            `UPDATE paid_upgrade_pending_receipt
             SET status = ?
             WHERE chain_id = ? AND nonce = ? AND signer_name = ?`,
            status,
            row.chain_id,
            row.nonce,
            row.signer_name,
        )
    }

    async alarm(): Promise<void> {
        await this.reconcilePendingReceipts()
    }

    private async schedulePaidUpgradeReconcile(): Promise<void> {
        const current = await this.ctx.storage.getAlarm()
        if (current === null) {
            await this.ctx.storage.setAlarm(Date.now() + 60_000)
        }
    }

    /**
     * Look up each pending broadcast. A receipt settles that nonce once, at
     * its gasUsed. A missing hash does not release the hold while another
     * hash for the nonce is pending, while the signer still has a replacement
     * for it, or while the signer nonce has not moved. A nonce that something
     * else consumed, with no receipt in hand, settles the full hold.
     */
    private async reconcilePendingReceipts(): Promise<void> {
        const sql = this.ensureUpgradeRateSchema()
        const pending = sql
            .exec<{ tx_hash: string; chain_id: number; nonce: number | null; signer_name: string | null }>(
                `SELECT tx_hash, chain_id, nonce, signer_name
                 FROM paid_upgrade_pending_receipt WHERE status = 'pending'`,
            )
            .toArray()
        for (const row of pending) {
            const found = await this.lookupPaidUpgradeReceipt(row.chain_id, row.tx_hash as Hex)
            if (found === 'wait' || found === 'mempool') continue
            if (found !== 'missing') {
                this.consumePaidUpgradeGas({
                    action: 'reconcile-receipt',
                    chainId: row.chain_id,
                    txHash: row.tx_hash,
                    found: true,
                    gas: found.gasUsed.toString(),
                    failure: found.failure,
                })
                continue
            }
            if (row.nonce == null || !row.signer_name) {
                this.consumePaidUpgradeGas({
                    action: 'reconcile-receipt',
                    chainId: row.chain_id,
                    txHash: row.tx_hash,
                    found: false,
                    nonceConsumed: true,
                })
                continue
            }
            if (this.hasPendingSibling(sql, row.tx_hash)) {
                this.consumePaidUpgradeGas({
                    action: 'reconcile-receipt',
                    chainId: row.chain_id,
                    txHash: row.tx_hash,
                    found: false,
                })
                continue
            }
            const tracked = await this.trackSignerReplacement(
                row.chain_id,
                row.signer_name,
                row.nonce,
                row.tx_hash as Hex,
            )
            if (tracked) continue
            const consumed = await this.signerNonceConsumed(row.chain_id, row.signer_name, row.nonce)
            if (consumed !== true) continue
            this.consumePaidUpgradeGas({
                action: 'reconcile-receipt',
                chainId: row.chain_id,
                txHash: row.tx_hash,
                found: true,
                gas: PAID_UPGRADE_GAS_HOLD.toString(),
                failure: false,
            })
        }
        const stillPending = sql
            .exec<{ n: number }>(
                `SELECT COUNT(*) AS n FROM paid_upgrade_pending_receipt WHERE status = 'pending'`,
            )
            .toArray()[0]
        if ((stillPending?.n ?? 0) > 0) {
            await this.ctx.storage.setAlarm(Date.now() + 60_000)
        }
    }

    private async lookupPaidUpgradeReceipt(
        chainId: number,
        txHash: Hex,
    ): Promise<
        'wait' | 'mempool' | 'missing' | { kind: 'settle'; gasUsed: bigint; failure: boolean }
    > {
        let rpcUrl: string
        try {
            rpcUrl = getChainRpcUrl(chainId, this.env)
        } catch (error) {
            logger.error({ error, chainId, txHash }, 'paid upgrade reconcile has no rpc')
            return 'wait'
        }
        const publicClient = createPublicClient({ transport: http(rpcUrl) })
        try {
            const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
            const outcome = paidUpgradeReceiptOutcome(receipt)
            return { kind: 'settle', gasUsed: outcome.gasUsed, failure: outcome.failure }
        } catch (error) {
            if (!isTransactionMissing(error)) {
                logger.error({ error, chainId, txHash }, 'paid upgrade reconcile receipt lookup failed')
                return 'wait'
            }
        }
        try {
            await publicClient.getTransaction({ hash: txHash })
            return 'mempool'
        } catch (error) {
            if (isTransactionMissing(error)) return 'missing'
            logger.error({ error, chainId, txHash }, 'paid upgrade reconcile tx lookup failed')
            return 'wait'
        }
    }

    /**
     * After a restart the signer row can hold the replacement hash before
     * this table does. Recording it here keeps the hold until that hash mines.
     */
    private async trackSignerReplacement(
        chainId: number,
        signerName: string,
        nonce: number,
        missingHash: Hex,
    ): Promise<boolean> {
        try {
            const signerId = this.env.SIGNER.idFromName(signerName)
            const signer = this.env.SIGNER.get(signerId)
            const response = await signer.fetch(
                `http://do/paid-upgrade-tx?nonce=${nonce}&signerName=${encodeURIComponent(signerName)}`,
            )
            if (!response.ok) return false
            const body = (await response.json()) as { txHash?: string } | null
            const txHash = parseTxHash(body?.txHash)
            if (!txHash || txHash.toLowerCase() === missingHash.toLowerCase()) return false
            const sql = this.ensureUpgradeRateSchema()
            const existing = this.pendingReceipt(sql, txHash)
            if (existing?.status === 'pending') return true
            if (existing) return false
            this.consumePaidUpgradeGas({
                action: 'track-replacement',
                chainId,
                priorHash: missingHash,
                txHash,
                nonce,
                signerName,
            })
            return true
        } catch (error) {
            logger.error({ error, chainId, signerName, nonce }, 'paid upgrade signer lookup failed')
            return false
        }
    }

    /** True only when the signer nonce has moved past this broadcast. */
    private async signerNonceConsumed(
        chainId: number,
        signerName: string,
        nonce: number,
    ): Promise<boolean | 'unknown'> {
        try {
            const signerId = this.env.SIGNER.idFromName(signerName)
            const signer = this.env.SIGNER.get(signerId)
            const response = await signer.fetch(
                `http://do/paid-upgrade-tx?nonce=${nonce}&signerName=${encodeURIComponent(signerName)}`,
            )
            if (!response.ok) return 'unknown'
            const body = (await response.json()) as { address?: string } | null
            if (!body?.address) return 'unknown'
            const rpcUrl = getChainRpcUrl(chainId, this.env)
            const publicClient = createPublicClient({ transport: http(rpcUrl) })
            const onChain = await publicClient.getTransactionCount({
                address: body.address as Address,
                blockTag: 'latest',
            })
            return onChain > nonce
        } catch (error) {
            logger.error({ error, chainId, signerName, nonce }, 'paid upgrade nonce lookup failed')
            return 'unknown'
        }
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
            sql.exec(`
                CREATE TABLE IF NOT EXISTS paid_upgrade_gas_budget (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    day_start INTEGER NOT NULL,
                    gas INTEGER NOT NULL,
                    held INTEGER NOT NULL,
                    failures INTEGER NOT NULL
                )
            `)
            sql.exec(`
                CREATE TABLE IF NOT EXISTS paid_upgrade_pending_receipt (
                    tx_hash TEXT PRIMARY KEY,
                    chain_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    enqueued_at INTEGER NOT NULL,
                    nonce INTEGER,
                    signer_name TEXT
                )
            `)
            const columns = new Set(
                sql
                    .exec<{ name: string }>(`PRAGMA table_info(paid_upgrade_pending_receipt)`)
                    .toArray()
                    .map((column) => column.name),
            )
            if (!columns.has('nonce')) {
                sql.exec(`ALTER TABLE paid_upgrade_pending_receipt ADD COLUMN nonce INTEGER`)
            }
            if (!columns.has('signer_name')) {
                sql.exec(`ALTER TABLE paid_upgrade_pending_receipt ADD COLUMN signer_name TEXT`)
            }
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
        let lastCode: SignerError['code'] | undefined

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
                    lastCode = error.code
                    continue
                }
                throw new SignerPoolSendError(error.error, true, error.code)
            } catch (err) {
                if (
                    err instanceof SignerPoolSendError &&
                    signerSendDisposition({
                        broadcastAttempted: err.broadcastAttempted,
                        message: err.message,
                    }) === 'retry'
                ) {
                    lastMessage = err.message
                    lastCode = err.code
                    continue
                }
                if (err instanceof SignerPoolSendError) throw err
                // The attempt has no before-send flag. Keep the reservation.
                throw new SignerPoolSendError(getErrorMessage(err), true)
            }
        }

        throw new SignerPoolSendError(
            lastMessage,
            poolSendBroadcastAttempted(attempts),
            lastCode,
        )
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
