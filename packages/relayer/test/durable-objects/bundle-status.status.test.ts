import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BundleStatusDO, type TxStatusResponse } from '../../src/durable-objects/bundle-status.do'
import { logger } from '../../src/lib/logger'

const mockLoggerWarn = vi.spyOn(logger, 'warn')

type BundleTxRow = {
    bundle_id: string
    tx_id: string
    signer_name: string | null
    created_at: number
}

class MockSqlStorage {
    public readonly queries: Array<{ query: string; params: unknown[] }> = []

    constructor(
        public txRows: BundleTxRow[],
        private readonly throwOnSignerNameUpdate: boolean = false,
        private readonly bundleColumns: Array<{ name: string }> = [
            { name: 'bundle_id' },
            { name: 'tx_id' },
            { name: 'signer_name' },
            { name: 'created_at' },
        ],
    ) {}

    exec(query: string, ...params: unknown[]): { toArray: () => Array<Record<string, unknown>> } {
        this.queries.push({ query, params })

        if (query.startsWith('SELECT tx_id, signer_name, created_at FROM bundle_transactions')) {
            const bundleId = String(params[0])

            return this.rows(
                this.txRows
                    .filter((row) => row.bundle_id === bundleId)
                    .map((row) => ({
                        tx_id: row.tx_id,
                        signer_name: row.signer_name,
                        created_at: row.created_at })),
            )
        }

        if (query.startsWith('UPDATE bundle_transactions SET signer_name = ?')) {
            if (this.throwOnSignerNameUpdate) {
                throw new Error('failed to update signer name')
            }

            const signerName = String(params[0])
            const bundleId = String(params[1])
            const txId = String(params[2])

            const row = this.txRows.find((candidate) => {
                return candidate.bundle_id === bundleId && candidate.tx_id === txId
            })

            if (row) row.signer_name = signerName

            return this.rows([])
        }

        if (query.startsWith('SELECT status FROM pending_bundles')) return this.rows([])

        if (query.startsWith('SELECT status FROM finished_bundles')) return this.rows([])

        if (query.startsWith('PRAGMA table_info(bundle_transactions)')) {
            return this.rows(this.bundleColumns)
        }

        if (query.startsWith('ALTER TABLE bundle_transactions ADD COLUMN created_at')) {
            return this.rows([])
        }

        if (query.startsWith('UPDATE bundle_transactions SET created_at = ?')) {
            const now = Number(params[0])

            for (const row of this.txRows) {
                if (!Number.isFinite(row.created_at) || row.created_at <= 0) {
                    row.created_at = now
                }
            }

            return this.rows([])
        }

        return this.rows([])
    }

    private rows(values: Array<Record<string, unknown>>) {
        return {
            toArray: () => values }
    }
}

type BundleStatusHost = {
    sql: MockSqlStorage
    ctx: { id: { name: string } }
    env: {
        RELAYER_COUNT: string
        BUNDLE_UNRESOLVED_SLA_MS: string
        SIGNER: {
            idFromName: (signerName: string) => string
            get: (signerName: string) => { fetch: (url: string) => Promise<Response> }
        }
    }
    get_bundle_status: BundleStatusDO['get_bundle_status']
    ensureBundleTransactionsSchema: () => void
}

function createDoStub(args: {
    txRows: BundleTxRow[]
    signerFetch: (signerName: string, txId: string) => TxStatusResponse | null
    relayerCount?: string
    unresolvedSlaMs?: string
    throwOnSignerNameUpdate?: boolean
    bundleColumns?: Array<{ name: string }>
}) {
    const sql = new MockSqlStorage(
        args.txRows,
        args.throwOnSignerNameUpdate ?? false,
        args.bundleColumns,
    )

    const stub: BundleStatusHost = Object.create(BundleStatusDO.prototype)

    stub.sql = sql
    stub.ctx = { id: { name: 'bundle-status-137' } }
    stub.env = {
        RELAYER_COUNT: args.relayerCount ?? '2',
        BUNDLE_UNRESOLVED_SLA_MS: args.unresolvedSlaMs ?? '300000',
        SIGNER: {
            idFromName: (signerName: string) => signerName,
            get: (signerName: string) => ({
                fetch: async (url: string) => {
                    const txId = new URL(url).searchParams.get('txId') ?? ''
                    const result = args.signerFetch(signerName, txId)

                    if (!result) return new Response('not found', { status: 404 })

                    return Response.json(result)
                } }) } }

    return { stub, sql }
}

function makeConfirmedTxStatus(): TxStatusResponse {
    return {
        txId: 'tx-1',
        txHash: '0xabc',
        chainId: 137,
        status: 'confirmed',
        blockNumber: '0x1',
        gasUsed: '0x5208',
        blockHash: '0xdef',
        logs: [],
        submittedAt: Date.now(),
        confirmedAt: Date.now() }
}

describe('BundleStatusDO status resolution', () => {
    beforeEach(() => {
        mockLoggerWarn.mockClear()
    })

    it('logs signer fetch failures via bundle status resolution path', async () => {
        const { stub } = createDoStub({
            txRows: [
                {
                    bundle_id: 'bundle-fetch-log-1',
                    tx_id: 'tx-fetch-1',
                    signer_name: 'signer-137-0',
                    created_at: Date.now() },
            ],
            signerFetch: () => {
                throw new Error('signer down')
            } })

        const result = await stub.get_bundle_status('bundle-fetch-log-1')

        expect(result.statusCode).toBe(100)
        expect(result.receipts).toHaveLength(0)
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'bundle_status_signer_fetch_failed',
                txId: 'tx-fetch-1',
                error: 'signer down' }),
            'failed to fetch transaction status from signer',
        )
    })

    it('recovers missing signer_name by probing signers and caches recovered signer', async () => {
        const { stub, sql } = createDoStub({
            txRows: [
                {
                    bundle_id: 'bundle-1',
                    tx_id: 'tx-1',
                    signer_name: null,
                    created_at: Date.now() },
            ],
            signerFetch: (signerName, txId) => {
                if (txId !== 'tx-1') return null

                if (signerName !== 'signer-137-1') return null

                return makeConfirmedTxStatus()
            } })

        const result = await stub.get_bundle_status('bundle-1')

        expect(result.statusCode).toBe(200)
        expect(result.receipts).toHaveLength(1)
        expect(sql.txRows[0].signer_name).toBe('signer-137-1')
    })

    it('logs signer cache update failure but still returns resolved tx status', async () => {
        const { stub } = createDoStub({
            txRows: [
                {
                    bundle_id: 'bundle-log-1',
                    tx_id: 'tx-log-1',
                    signer_name: 'signer-137-0',
                    created_at: Date.now() },
            ],
            signerFetch: (signerName, txId) => {
                if (txId !== 'tx-log-1') return null

                if (signerName === 'signer-137-0') return null

                if (signerName === 'signer-137-1') return makeConfirmedTxStatus()

                return null
            },
            throwOnSignerNameUpdate: true })

        const result = await stub.get_bundle_status('bundle-log-1')

        expect(result.statusCode).toBe(200)
        expect(result.receipts).toHaveLength(1)
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'bundle_status_signer_cache_update_failed',
                bundleId: 'bundle-log-1',
                txId: 'tx-log-1',
                signerName: 'signer-137-0',
                resolvedSignerName: 'signer-137-1',
                chainId: 137,
                error: 'failed to update signer name' }),
            'failed to cache resolved signer name for bundle transaction',
        )
    })

    it('keeps status pending when unresolved and under SLA', async () => {
        const { stub } = createDoStub({
            txRows: [
                {
                    bundle_id: 'bundle-2',
                    tx_id: 'tx-2',
                    signer_name: null,
                    created_at: Date.now() },
            ],
            signerFetch: () => null,
            unresolvedSlaMs: '300000' })

        const result = await stub.get_bundle_status('bundle-2')

        expect(result.statusCode).toBe(100)
        expect(result.receipts).toHaveLength(0)
    })

    it('terminalizes unresolved tracked bundles beyond SLA as failed', async () => {
        const { stub } = createDoStub({
            txRows: [
                {
                    bundle_id: 'bundle-3',
                    tx_id: 'tx-3',
                    signer_name: null,
                    created_at: Date.now() - 10_000 },
            ],
            signerFetch: () => null,
            unresolvedSlaMs: '1000' })

        const result = await stub.get_bundle_status('bundle-3')

        expect(result.statusCode).toBe(300)
        expect(result.status).toBe('failed')
        expect(result.receipts).toHaveLength(0)
    })

    it('adds created_at column in bundle transaction schema migration when missing', () => {
        const { stub, sql } = createDoStub({
            txRows: [
                {
                    bundle_id: 'bundle-4',
                    tx_id: 'tx-4',
                    signer_name: 'signer-137-0',
                    created_at: 0 },
            ],
            signerFetch: () => null,
            bundleColumns: [{ name: 'bundle_id' }, { name: 'tx_id' }, { name: 'signer_name' }] })

        stub.ensureBundleTransactionsSchema()

        expect(
            sql.queries.some((entry) =>
                entry.query.startsWith('ALTER TABLE bundle_transactions ADD COLUMN created_at'),
            ),
        ).toBe(true)
        expect(sql.txRows[0].created_at).toBeGreaterThan(0)
    })
})
