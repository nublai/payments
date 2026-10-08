import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import { BundleStatusDO } from '../../src/durable-objects/bundle-status.do'

type BundleStatusDoLike = Pick<
    BundleStatusDO,
    | 'fetch'
    | 'add_bundle_tx'
    | 'get_bundle_status'
    | 'getBundleIdByTxId'
    | 'upsertBundleTelemetry'
    | 'getBundleTelemetry'
    | 'getBundlesByEoa'
>

function createDoStub(): BundleStatusDoLike {
    return {
        fetch: BundleStatusDO.prototype.fetch,
        add_bundle_tx: vi.fn().mockResolvedValue(undefined),
        get_bundle_status: vi.fn().mockResolvedValue({
            bundleId: 'bundle-1',
            status: 'pending',
            statusCode: 100,
            receipts: [],
        }),
        getBundleIdByTxId: vi.fn().mockResolvedValue({ bundleId: 'bundle-1' }),
        upsertBundleTelemetry: vi.fn().mockResolvedValue(undefined),
        getBundleTelemetry: vi.fn().mockResolvedValue({
            bundleId: 'bundle-1',
            chainId: 8453,
            eoa: '0x1234567890123456789012345678901234567890' as Address,
            paymentEnabled: true,
            simulationGas: '1',
            combinedGas: '2',
            txGas: '3',
            createdAt: Date.now(),
        }),
        getBundlesByEoa: vi.fn().mockReturnValue({
            items: [{ bundleId: 'bundle-1', chainId: 8453, createdAt: 123 }],
            total: 1,
        }),
    }
}

describe('BundleStatusDO fetch route retirement', () => {
    it.each([
        ['POST', '/store_pending_bundle'],
        ['POST', '/update_bundle_status'],
        ['POST', '/finish_bundle'],
        ['POST', '/init_multichain_bundle'],
        ['GET', '/get_pending_bundle?bundleId=bundle-1'],
        ['GET', '/is_bundle_finished?bundleId=bundle-1'],
        ['POST', '/schedule_refund'],
        ['GET', '/get_ready_refunds'],
        ['POST', '/claim_ready_refunds'],
        ['POST', '/remove_refund'],
        ['POST', '/start_fulfillment'],
        ['POST', '/complete_fulfillment'],
        ['GET', '/get_fulfillment_attempt?escrowId=0x1'],
        ['POST', '/start_settlement'],
        ['POST', '/complete_settlement'],
        ['POST', '/start_refund'],
        ['POST', '/complete_refund'],
    ])('returns 404 for retired route %s %s', async (method, path) => {
        const doStub = createDoStub()

        const requestInit =
            method === 'POST'
                ? {
                      method,
                      headers: { 'Content-Type': 'application/json' },
                      body: '{}',
                  }
                : { method }

        const response = await BundleStatusDO.prototype.fetch.call(
            doStub as unknown as BundleStatusDO,
            new Request(`https://example.com${path}`, requestInit),
        )

        expect(response.status).toBe(404)
    })

    it('keeps add_bundle_tx route active', async () => {
        const doStub = createDoStub()

        const response = await BundleStatusDO.prototype.fetch.call(
            doStub as unknown as BundleStatusDO,
            new Request('https://example.com/add_bundle_tx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bundleId: 'bundle-1',
                    txId: 'tx-1',
                    signerName: 'signer-1',
                }),
            }),
        )

        expect(response.status).toBe(200)
        expect(doStub.add_bundle_tx).toHaveBeenCalledWith('bundle-1', 'tx-1', 'signer-1')
    })

    it('keeps get_bundle_status route active', async () => {
        const doStub = createDoStub()

        const response = await BundleStatusDO.prototype.fetch.call(
            doStub as unknown as BundleStatusDO,
            new Request('https://example.com/get_bundle_status?bundleId=bundle-1'),
        )

        expect(response.status).toBe(200)
        expect(doStub.get_bundle_status).toHaveBeenCalledWith('bundle-1')
    })

    it('keeps get_bundle_id_by_tx route active', async () => {
        const doStub = createDoStub()

        const response = await BundleStatusDO.prototype.fetch.call(
            doStub as unknown as BundleStatusDO,
            new Request('https://example.com/get_bundle_id_by_tx?txId=tx-1'),
        )

        expect(response.status).toBe(200)
        expect(doStub.getBundleIdByTxId).toHaveBeenCalledWith('tx-1')
    })

    it('keeps upsert_bundle_telemetry route active', async () => {
        const doStub = createDoStub()

        const response = await BundleStatusDO.prototype.fetch.call(
            doStub as unknown as BundleStatusDO,
            new Request('https://example.com/upsert_bundle_telemetry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bundleId: 'bundle-1',
                    chainId: 8453,
                    paymentEnabled: true,
                    simulationGas: '1',
                    combinedGas: '2',
                    txGas: '3',
                }),
            }),
        )

        expect(response.status).toBe(200)
        expect(doStub.upsertBundleTelemetry).toHaveBeenCalled()
    })

    it('keeps get_bundle_telemetry route active', async () => {
        const doStub = createDoStub()

        const response = await BundleStatusDO.prototype.fetch.call(
            doStub as unknown as BundleStatusDO,
            new Request('https://example.com/get_bundle_telemetry?bundleId=bundle-1'),
        )

        expect(response.status).toBe(200)
        expect(doStub.getBundleTelemetry).toHaveBeenCalledWith('bundle-1')
    })

    it('keeps get_bundles_by_eoa route active without clamping large limits', async () => {
        const doStub = createDoStub()

        const response = await BundleStatusDO.prototype.fetch.call(
            doStub as unknown as BundleStatusDO,
            new Request(
                'https://example.com/get_bundles_by_eoa?eoa=0x1234567890123456789012345678901234567890&limit=5000&offset=1000',
            ),
        )

        expect(response.status).toBe(200)
        expect(doStub.getBundlesByEoa).toHaveBeenCalledWith(
            '0x1234567890123456789012345678901234567890',
            5000,
            1000,
        )
    })

    it('returns 400 for invalid get_bundles_by_eoa pagination params', async () => {
        const doStub = createDoStub()

        const badLimit = await BundleStatusDO.prototype.fetch.call(
            doStub as unknown as BundleStatusDO,
            new Request(
                'https://example.com/get_bundles_by_eoa?eoa=0x1234567890123456789012345678901234567890&limit=0&offset=0',
            ),
        )

        expect(badLimit.status).toBe(400)

        const badOffset = await BundleStatusDO.prototype.fetch.call(
            doStub as unknown as BundleStatusDO,
            new Request(
                'https://example.com/get_bundles_by_eoa?eoa=0x1234567890123456789012345678901234567890&limit=20&offset=-1',
            ),
        )

        expect(badOffset.status).toBe(400)
    })
})
