/**
 * BundleStatusDO - Durable Object for bundle status tracking
 *
 * Active runtime responsibilities:
 * - bundle_transactions: Maps bundle_id → tx_id (with signer_name for lookup)
 * - bundle_gas_telemetry: Stores quote-vs-actual gas inputs for logging
 *
 * Legacy crosschain tables are retained for compatibility/readability during rollout.
 *
 * DO naming convention: "bundle-status-{chainId}"
 * Example: "bundle-status-8453" for Base mainnet
 */

import { DurableObject } from 'cloudflare:workers'
import { decodeEventLog, type Address } from 'viem'
import { orchestratorAbi } from '@nubl/contracts/abis'
import type { Env } from '../types/env'
import type { Hex } from 'viem'
import { getErrorMessage, logger } from '../lib/logger'

const DEFAULT_BUNDLE_UNRESOLVED_SLA_MS = 300_000

/**
 * Transaction status response from SignerDO
 */
export interface TxStatusResponse {
    txId: string
    txHash: Hex
    chainId: number
    status: 'pending' | 'confirmed' | 'failed'
    blockNumber?: string
    gasUsed?: string
    blockHash?: string
    logs?: unknown[]
    submittedAt: number
    confirmedAt?: number
}

/**
 * Bundle status result
 */
export interface BundleStatusResult {
    bundleId: string
    status: 'pending' | 'confirmed' | 'failed' | 'not_found'
    statusCode: number // 100 | 200 | 201 | 300 | 400 | 500 | 404
    receipts: Array<{
        chain_id: string
        transaction_hash: Hex
        status: boolean
        block_hash?: string
        block_number?: string
        gas_used: string
        logs: unknown[]
        /** Intent execution error (bytes4 selector, e.g., 0x9054c912 for ExceededSpendLimit) */
        intent_error?: Hex
    }>
}

interface BundleGasTelemetry {
    bundleId: string
    chainId: number
    eoa?: Address
    paymentEnabled: boolean
    simulationGas?: string
    combinedGas?: string
    txGas?: string
    createdAt: number
}

/**
 * BundleStatusDO - SQLite-backed bundle status tracking
 */
export class BundleStatusDO extends DurableObject<Env> {
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
        // Create bundle_transactions table
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS bundle_transactions (
                bundle_id TEXT NOT NULL,
                tx_id TEXT NOT NULL,
                signer_name TEXT,
                PRIMARY KEY (bundle_id, tx_id)
            );
            CREATE INDEX IF NOT EXISTS idx_bundle_transactions_tx_id ON bundle_transactions(tx_id);
            CREATE INDEX IF NOT EXISTS idx_bundle_transactions_signer ON bundle_transactions(signer_name);
        `)
        this.ensureBundleTransactionsSchema()

        // Create pending_bundles table
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS pending_bundles (
                bundle_id TEXT PRIMARY KEY,
                status TEXT NOT NULL CHECK(status IN (
                    'init', 'source_queued', 'source_confirmed', 'source_failures',
                    'destination_queued', 'destination_failures', 'destination_confirmed',
                    'refunds_queued', 'withdrawals_queued', 'done', 'failed',
                    'settlements_queued', 'settlements_confirmed', 'settlements_processing', 'settlements_failures',
                    'settlement_completion_queued', 'refunds_scheduled', 'refunds_ready',
                    'fee_payer_queued', 'fee_payer_completed'
                )),
                bundle_data TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_pending_bundles_created_at ON pending_bundles(created_at);
            CREATE INDEX IF NOT EXISTS idx_pending_bundles_status ON pending_bundles(status);
        `)

        // Create finished_bundles table
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS finished_bundles (
                bundle_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                bundle_data TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                finished_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_finished_bundles_finished_at ON finished_bundles(finished_at);
            CREATE INDEX IF NOT EXISTS idx_finished_bundles_status ON finished_bundles(status);
        `)

        // Create pending_refunds table
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS pending_refunds (
                bundle_id TEXT PRIMARY KEY,
                refund_timestamp INTEGER NOT NULL,
                input_chain_id INTEGER NOT NULL,
                escrow_id TEXT NOT NULL,
                escrow_address TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pending_refunds_timestamp ON pending_refunds(refund_timestamp);
        `)
        this.ensurePendingRefundsSchema()

        // Create fulfillment_attempts table for idempotency protection
        // Prevents double-spend if queue send fails after tx is broadcast
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS fulfillment_attempts (
                escrow_id TEXT PRIMARY KEY,
                bundle_id TEXT NOT NULL,
                tx_hash TEXT,
                status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'confirmed', 'failed')),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_fulfillment_attempts_bundle ON fulfillment_attempts(bundle_id);
        `)

        // Create settlement_attempts table for idempotency protection
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS settlement_attempts (
                escrow_id TEXT PRIMARY KEY,
                bundle_id TEXT NOT NULL,
                write_tx_hash TEXT,
                settle_tx_hash TEXT,
                status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'confirmed', 'failed')),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_settlement_attempts_bundle ON settlement_attempts(bundle_id);
        `)

        // Create refund_attempts table for idempotency protection
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS refund_attempts (
                escrow_id TEXT PRIMARY KEY,
                bundle_id TEXT NOT NULL,
                tx_hash TEXT,
                status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'confirmed', 'failed')),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_refund_attempts_bundle ON refund_attempts(bundle_id);
        `)

        // Create bundle_gas_telemetry table for gas tuning analysis
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS bundle_gas_telemetry (
                bundle_id TEXT PRIMARY KEY,
                chain_id INTEGER NOT NULL,
                eoa TEXT,
                payment_enabled INTEGER NOT NULL DEFAULT 0,
                simulation_gas TEXT,
                combined_gas TEXT,
                tx_gas TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bundle_gas_telemetry_chain ON bundle_gas_telemetry(chain_id);
            CREATE INDEX IF NOT EXISTS idx_bundle_gas_telemetry_created ON bundle_gas_telemetry(created_at);
            CREATE INDEX IF NOT EXISTS idx_bundle_gas_telemetry_eoa ON bundle_gas_telemetry(eoa);
        `)

        this.applyBundleGasTelemetryEoaNormalizationMigration()
    }

    /**
     * One-time data migration: normalize legacy mixed-case EOAs.
     * This keeps `WHERE eoa = ?` index-friendly and avoids repeated cold-start writes.
     */
    private applyBundleGasTelemetryEoaNormalizationMigration(): void {
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );
        `)

        const migrationName = 'bundle_gas_telemetry_eoa_lowercase_v1'

        const existing = this.sql
            .exec('SELECT name FROM schema_migrations WHERE name = ?', migrationName)
            .toArray()

        if (existing.length > 0) {
            return
        }

        this.sql.exec(
            'UPDATE bundle_gas_telemetry SET eoa = LOWER(eoa) WHERE eoa IS NOT NULL AND eoa != LOWER(eoa)',
        )
        this.sql.exec(
            'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
            migrationName,
            Date.now(),
        )
    }

    /**
     * Backward-compatible migration for older pending_refunds schemas.
     * Adds columns required by claimReadyRefunds if they are missing.
     */
    private ensurePendingRefundsSchema(): void {
        const columns = new Set(
            this.sql
                .exec('PRAGMA table_info(pending_refunds)')
                .toArray()
                .map((row) => String((row as { name?: unknown }).name ?? '')),
        )

        const requiredColumns: Array<{ name: string; definition: string }> = [
            { name: 'input_chain_id', definition: 'INTEGER NOT NULL DEFAULT 0' },
            { name: 'escrow_id', definition: "TEXT NOT NULL DEFAULT ''" },
            { name: 'escrow_address', definition: "TEXT NOT NULL DEFAULT ''" },
            { name: 'created_at', definition: 'INTEGER NOT NULL DEFAULT 0' },
        ]

        for (const column of requiredColumns) {
            if (columns.has(column.name)) continue

            try {
                this.sql.exec(
                    `ALTER TABLE pending_refunds ADD COLUMN ${column.name} ${column.definition}`,
                )
            } catch (error) {
                const message = getErrorMessage(error)

                // Safe to ignore races/duplicate additions; rethrow anything else.
                if (!message.includes('duplicate column name')) {
                    throw error
                }
            }
        }
    }

    /**
     * Backward-compatible migration for bundle_transactions metadata.
     * Adds created_at for unresolved-bundle SLA tracking.
     */
    private ensureBundleTransactionsSchema(): void {
        const columns = new Set(
            this.sql
                .exec('PRAGMA table_info(bundle_transactions)')
                .toArray()
                .map((row) => String((row as { name?: unknown }).name ?? '')),
        )

        if (!columns.has('created_at')) {
            this.sql.exec(
                'ALTER TABLE bundle_transactions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0',
            )
        }

        const now = Date.now()
        this.sql.exec(
            'UPDATE bundle_transactions SET created_at = ? WHERE created_at IS NULL OR created_at <= 0',
            now,
        )
    }

    private getChainIdFromName(): number {
        const name = this.ctx.id.name

        if (!name) return 0
        const parts = name.split('-')

        if (parts.length !== 3 || parts[0] !== 'bundle' || parts[1] !== 'status') return 0
        const chainId = Number.parseInt(parts[2], 10)

        return Number.isFinite(chainId) ? chainId : 0
    }

    private getBundleUnresolvedSlaMs(): number {
        const parsed = Number.parseInt(
            this.env.BUNDLE_UNRESOLVED_SLA_MS ?? String(DEFAULT_BUNDLE_UNRESOLVED_SLA_MS),
            10,
        )

        return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUNDLE_UNRESOLVED_SLA_MS
    }

    private async fetchTxStatusFromSigner(
        txId: string,
        signerName: string,
    ): Promise<TxStatusResponse | null> {
        try {
            const signerId = this.env.SIGNER.idFromName(signerName)
            const signer = this.env.SIGNER.get(signerId)
            const response = await signer.fetch(`http://do/get_tx_status?txId=${txId}`)

            if (!response.ok) return null

            return (await response.json()) as TxStatusResponse
        } catch (error) {
            logger.warn(
                {
                    event: 'bundle_status_signer_fetch_failed',
                    txId,
                    signerName,
                    error: getErrorMessage(error),
                },
                'failed to fetch transaction status from signer',
            )

            return null
        }
    }

    private async probeSignerForTxStatus(
        txId: string,
        chainId: number,
        skipSignerName?: string,
    ): Promise<{ txStatus: TxStatusResponse | null; signerName: string | null }> {
        const signerCount = Number.parseInt(this.env.RELAYER_COUNT ?? '1', 10)
        const maxSigners = Number.isFinite(signerCount) && signerCount > 0 ? signerCount : 1

        for (let index = 0; index < maxSigners; index += 1) {
            const signerName = `signer-${chainId}-${index}`

            if (skipSignerName && signerName === skipSignerName) continue
            const txStatus = await this.fetchTxStatusFromSigner(txId, signerName)

            if (txStatus) {
                return { txStatus, signerName }
            }
        }

        return { txStatus: null, signerName: null }
    }

    /**
     * HTTP handler for BundleStatusDO endpoints
     */
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const path = url.pathname

        try {
            if (request.method === 'POST' && path === '/add_bundle_tx') {
                const body = (await request.json()) as {
                    bundleId: string
                    txId: string
                    signerName?: string
                }

                await this.add_bundle_tx(body.bundleId, body.txId, body.signerName)

                return Response.json({ success: true })
            }

            if (request.method === 'POST' && path === '/upsert_bundle_telemetry') {
                const body = (await request.json()) as {
                    bundleId: string
                    chainId: number
                    eoa?: Address
                    paymentEnabled: boolean
                    simulationGas?: string
                    combinedGas?: string
                    txGas?: string
                }

                await this.upsertBundleTelemetry(body)

                return Response.json({ success: true })
            }

            if (request.method === 'GET' && path === '/get_bundle_status') {
                const bundleId = url.searchParams.get('bundleId')

                if (!bundleId) {
                    return Response.json({ error: 'Missing bundleId parameter' }, { status: 400 })
                }

                const result = await this.get_bundle_status(bundleId)

                return Response.json(result)
            }

            // Reverse lookup: get bundleId from txId
            if (request.method === 'GET' && path === '/get_bundle_id_by_tx') {
                const txId = url.searchParams.get('txId')

                if (!txId) {
                    return Response.json({ error: 'Missing txId parameter' }, { status: 400 })
                }

                const result = await this.getBundleIdByTxId(txId)

                return Response.json(result)
            }

            if (request.method === 'GET' && path === '/get_bundle_telemetry') {
                const bundleId = url.searchParams.get('bundleId')

                if (!bundleId) {
                    return Response.json({ error: 'Missing bundleId parameter' }, { status: 400 })
                }

                const result = await this.getBundleTelemetry(bundleId)

                return Response.json(result)
            }

            if (request.method === 'GET' && path === '/get_bundles_by_eoa') {
                const eoa = url.searchParams.get('eoa')

                if (!eoa) {
                    return Response.json({ error: 'Missing eoa parameter' }, { status: 400 })
                }

                const limit = Number(url.searchParams.get('limit') ?? '20')
                const offset = Number(url.searchParams.get('offset') ?? '0')

                if (!Number.isInteger(limit) || limit < 1) {
                    return Response.json(
                        { error: 'limit must be a positive integer' },
                        { status: 400 },
                    )
                }

                if (!Number.isInteger(offset) || offset < 0) {
                    return Response.json(
                        { error: 'offset must be a non-negative integer' },
                        { status: 400 },
                    )
                }

                const result = this.getBundlesByEoa(eoa, limit, offset)

                return Response.json(result)
            }

            return Response.json({ error: 'Not found' }, { status: 404 })
        } catch (error) {
            const message = getErrorMessage(error)

            return Response.json({ error: message }, { status: 500 })
        }
    }

    /**
     * Map bundle ID to transaction ID
     */
    async add_bundle_tx(bundleId: string, txId: string, signerName?: string): Promise<void> {
        this.sql.exec(
            'INSERT OR IGNORE INTO bundle_transactions (bundle_id, tx_id, signer_name, created_at) VALUES (?, ?, ?, ?)',
            bundleId,
            txId,
            signerName ?? null,
            Date.now(),
        )
    }

    /**
     * Get aggregated bundle status by querying transactions
     */
    async get_bundle_status(bundleId: string): Promise<BundleStatusResult> {
        // Get all transaction IDs for this bundle (check bundle_transactions first)
        const txRows = this.sql
            .exec(
                'SELECT tx_id, signer_name, created_at FROM bundle_transactions WHERE bundle_id = ?',
                bundleId,
            )
            .toArray()

        // If no transactions found, check pending/finished bundles (for multichain bundles)
        if (txRows.length === 0) {
            const pendingRows = this.sql
                .exec('SELECT status FROM pending_bundles WHERE bundle_id = ?', bundleId)
                .toArray()

            const finishedRows = this.sql
                .exec('SELECT status FROM finished_bundles WHERE bundle_id = ?', bundleId)
                .toArray()

            if (pendingRows.length === 0 && finishedRows.length === 0) {
                return {
                    bundleId,
                    status: 'not_found',
                    statusCode: 404,
                    receipts: [],
                }
            }

            // Bundle exists in pending/finished but no transactions yet
            return {
                bundleId,
                status: 'pending',
                statusCode: 100,
                receipts: [],
            }
        }

        // Query SignerDO for each transaction status
        const transactions: TxStatusResponse[] = []
        const chainId = this.getChainIdFromName()

        for (const row of txRows) {
            const txId = row.tx_id as string
            const signerName = row.signer_name as string | null

            if (!signerName) {
                logger.warn(
                    {
                        event: 'bundle_status_missing_signer_name',
                        bundleId,
                        txId,
                    },
                    'bundle transaction missing signer_name; probing signers',
                )
            }

            try {
                let txStatus = signerName
                    ? await this.fetchTxStatusFromSigner(txId, signerName)
                    : null

                let resolvedSignerName: string | null = signerName

                if (!txStatus && chainId > 0) {
                    const probed = await this.probeSignerForTxStatus(
                        txId,
                        chainId,
                        signerName ?? undefined,
                    )

                    txStatus = probed.txStatus
                    resolvedSignerName = probed.signerName
                }

                if (!txStatus) {
                    logger.warn(
                        {
                            event: 'bundle_status_signer_probe_failed',
                            bundleId,
                            txId,
                            signerName,
                            chainId,
                        },
                        'failed to resolve signer tx status for bundle transaction',
                    )
                    continue
                }

                if (resolvedSignerName && resolvedSignerName !== signerName) {
                    try {
                        this.sql.exec(
                            'UPDATE bundle_transactions SET signer_name = ? WHERE bundle_id = ? AND tx_id = ?',
                            resolvedSignerName,
                            bundleId,
                            txId,
                        )
                    } catch (error) {
                        logger.warn(
                            {
                                event: 'bundle_status_signer_cache_update_failed',
                                bundleId,
                                txId,
                                signerName,
                                resolvedSignerName,
                                chainId,
                                error: getErrorMessage(error),
                            },
                            'failed to cache resolved signer name for bundle transaction',
                        )
                    }
                }

                transactions.push(txStatus)
            } catch (error) {
                logger.warn(
                    {
                        event: 'bundle_status_tx_resolution_failed',
                        bundleId,
                        txId,
                        signerName,
                        chainId,
                        error: getErrorMessage(error),
                    },
                    'failed during bundle transaction status resolution',
                )
                continue
            }
        }

        if (transactions.length === 0) {
            const oldestCreatedAt = txRows.reduce((oldest, row) => {
                const createdAt = Number(row.created_at ?? 0)

                if (!Number.isFinite(createdAt) || createdAt <= 0) return oldest

                return Math.min(oldest, createdAt)
            }, Number.MAX_SAFE_INTEGER)

            const safeOldestCreatedAt =
                oldestCreatedAt === Number.MAX_SAFE_INTEGER ? Date.now() : oldestCreatedAt

            const ageMs = Date.now() - safeOldestCreatedAt
            const unresolvedSlaMs = this.getBundleUnresolvedSlaMs()

            if (ageMs >= unresolvedSlaMs) {
                logger.error(
                    {
                        event: 'bundle_unresolvable_sla_failed',
                        reason: 'unresolvable_bundle_tracking_timeout',
                        bundleId,
                        ageMs,
                        unresolvedSlaMs,
                        txCount: txRows.length,
                        chainId,
                    },
                    'bundle unresolved beyond SLA; terminalizing as failed',
                )

                return {
                    bundleId,
                    status: 'failed',
                    statusCode: 300,
                    receipts: [],
                }
            }

            // No transaction statuses available, return pending
            return {
                bundleId,
                status: 'pending',
                statusCode: 100,
                receipts: [],
            }
        }

        // Build receipts and check for intent-level reverts
        const receipts = transactions.map((tx) => this.buildReceipt(tx))
        const hasPending = transactions.some((tx) => tx.status === 'pending')
        const anyFailed = transactions.some((tx) => tx.status === 'failed')
        const anyReverted = receipts.some((r) => r.intent_error !== undefined)

        const allReverted =
            receipts.length > 0 && receipts.every((r) => r.intent_error !== undefined)

        // Determine status code based on priority:
        // 300 = Failed (tx never submitted/mined)
        // 100 = Pending (still waiting for confirmation)
        // 400 = Reverted (tx mined but all intents failed on-chain)
        // 500 = PartiallyReverted (some intents in bundle failed)
        // 200 = Confirmed (success)
        if (anyFailed) {
            return {
                bundleId,
                status: 'failed',
                statusCode: 300,
                receipts,
            }
        }

        if (hasPending) {
            return {
                bundleId,
                status: 'pending',
                statusCode: 100,
                receipts: receipts.filter((_, i) => transactions[i].status !== 'pending'),
            }
        }

        if (allReverted) {
            return {
                bundleId,
                status: 'failed',
                statusCode: 400, // Reverted - intent failed on-chain
                receipts,
            }
        }

        if (anyReverted) {
            return {
                bundleId,
                status: 'failed',
                statusCode: 500, // PartiallyReverted - some intents failed
                receipts,
            }
        }

        return {
            bundleId,
            status: 'confirmed',
            statusCode: 200,
            receipts,
        }
    }

    /**
     * Build receipt from transaction status
     */
    private buildReceipt(tx: TxStatusResponse): BundleStatusResult['receipts'][0] {
        const intentError = this.extractIntentError(tx.logs)

        return {
            chain_id: `0x${tx.chainId.toString(16)}`,
            transaction_hash: tx.txHash,
            status: tx.status === 'confirmed',
            block_hash: tx.blockHash || undefined,
            block_number: tx.blockNumber || undefined,
            gas_used: tx.gasUsed || '0x0',
            logs: tx.logs || [],
            intent_error: intentError,
        }
    }

    /**
     * Extract intent error from IntentExecuted event logs
     * Returns the bytes4 error selector if the intent failed, undefined otherwise
     */
    private extractIntentError(logs: unknown[] | undefined): Hex | undefined {
        if (!logs || logs.length === 0) return undefined

        for (const log of logs) {
            try {
                const logEntry = log as { topics?: Hex[]; data?: Hex }

                if (!logEntry.topics || logEntry.topics.length === 0) continue

                const decoded = decodeEventLog({
                    abi: orchestratorAbi,
                    data: logEntry.data,
                    topics: logEntry.topics as [Hex, ...Hex[]],
                })

                if (decoded.eventName === 'IntentExecuted') {
                    const args = decoded.args as { err?: Hex }

                    if (args.err && args.err !== '0x00000000') {
                        return args.err
                    }
                }
            } catch {
                // Not an IntentExecuted event or decoding failed, continue
            }
        }

        return undefined
    }

    /**
     * Reverse lookup: get bundleId from txId
     * Uses bundle_transactions table which maps bundleId → txId
     */
    async getBundleIdByTxId(txId: string): Promise<{ bundleId: string | null }> {
        const rows = this.sql
            .exec('SELECT bundle_id FROM bundle_transactions WHERE tx_id = ?', txId)
            .toArray()

        if (rows.length === 0) {
            return { bundleId: null }
        }

        return { bundleId: String(rows[0].bundle_id) }
    }

    async upsertBundleTelemetry(input: {
        bundleId: string
        chainId: number
        eoa?: Address
        paymentEnabled: boolean
        simulationGas?: string
        combinedGas?: string
        txGas?: string
    }): Promise<void> {
        const normalizedEoa = input.eoa?.toLowerCase()
        this.sql.exec(
            `INSERT OR REPLACE INTO bundle_gas_telemetry
                (bundle_id, chain_id, eoa, payment_enabled, simulation_gas, combined_gas, tx_gas, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            input.bundleId,
            input.chainId,
            normalizedEoa ?? null,
            input.paymentEnabled ? 1 : 0,
            input.simulationGas ?? null,
            input.combinedGas ?? null,
            input.txGas ?? null,
            Date.now(),
        )
    }

    async getBundleTelemetry(bundleId: string): Promise<BundleGasTelemetry | null> {
        const rows = this.sql
            .exec(
                `SELECT bundle_id, chain_id, eoa, payment_enabled, simulation_gas, combined_gas, tx_gas, created_at
                 FROM bundle_gas_telemetry WHERE bundle_id = ?`,
                bundleId,
            )
            .toArray()

        if (rows.length === 0) return null

        const row = rows[0] as Record<string, unknown>

        return {
            bundleId: String(row.bundle_id),
            chainId: Number(row.chain_id),
            eoa: row.eoa ? (String(row.eoa) as Address) : undefined,
            paymentEnabled: Number(row.payment_enabled) === 1,
            simulationGas: row.simulation_gas ? String(row.simulation_gas) : undefined,
            combinedGas: row.combined_gas ? String(row.combined_gas) : undefined,
            txGas: row.tx_gas ? String(row.tx_gas) : undefined,
            createdAt: Number(row.created_at),
        }
    }

    getBundlesByEoa(
        eoa: string,
        limit: number,
        offset: number,
    ): { items: Array<{ bundleId: string; chainId: number; createdAt: number }>; total: number } {
        const normalizedEoa = eoa.toLowerCase()

        const countRows = this.sql
            .exec('SELECT COUNT(*) as count FROM bundle_gas_telemetry WHERE eoa = ?', normalizedEoa)
            .toArray()

        const total = Number((countRows[0] as Record<string, unknown>).count ?? 0)

        const itemRows = this.sql
            .exec(
                'SELECT bundle_id, chain_id, created_at FROM bundle_gas_telemetry WHERE eoa = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
                normalizedEoa,
                limit,
                offset,
            )
            .toArray()

        const items = itemRows.map((row) => {
            const r = row as Record<string, unknown>

            return {
                bundleId: String(r.bundle_id),
                chainId: Number(r.chain_id),
                createdAt: Number(r.created_at),
            }
        })

        return { items, total }
    }
}
