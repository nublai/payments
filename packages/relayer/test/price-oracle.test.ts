import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    getUsdPrice,
    getEthUsdPrice,
    getRegistryState,
    lookupUsd,
    resetPriceRegistry,
    updatePrices,
} from '../src/services/price-oracle'

vi.mock('../src/lib/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

describe('price oracle', () => {
    let originalFetch: typeof fetch | undefined

    beforeEach(() => {
        resetPriceRegistry()
        vi.restoreAllMocks()

        if (originalFetch === undefined) {
            originalFetch = globalThis.fetch
        }
    })

    afterEach(() => {
        if (originalFetch) {
            globalThis.fetch = originalFetch
        }
    })

    it('returns null for expired prices', async () => {
        const provider = {
            id: 'mock',
            fetchUsdPrices: vi.fn().mockResolvedValue({
                ethereum: { usd: '2000' },
            }),
        }

        const nowSpy = vi.spyOn(Date, 'now')
        nowSpy.mockReturnValueOnce(1_000_000)

        await updatePrices(
            {
                providerId: 'mock',
                assetMapping: { eth: 'ethereum' },
                rateTtlMs: 500,
                fetchIntervalMs: 0,
            },
            provider,
        )

        nowSpy.mockReturnValueOnce(1_000_501)
        const price = lookupUsd('eth', { rateTtlMs: 500 })
        expect(price).toBeNull()
    })

    it('throttles fetches by fetchIntervalMs', async () => {
        const provider = {
            id: 'mock',
            fetchUsdPrices: vi.fn().mockResolvedValue({
                ethereum: { usd: '2000' },
            }),
        }

        const nowSpy = vi.spyOn(Date, 'now')
        nowSpy.mockReturnValueOnce(1_000_000)

        await updatePrices(
            {
                providerId: 'mock',
                assetMapping: { eth: 'ethereum' },
                rateTtlMs: 5_000,
                fetchIntervalMs: 60_000,
            },
            provider,
        )

        nowSpy.mockReturnValueOnce(1_000_500)
        await updatePrices(
            {
                providerId: 'mock',
                assetMapping: { eth: 'ethereum' },
                rateTtlMs: 5_000,
                fetchIntervalMs: 60_000,
            },
            provider,
        )

        expect(provider.fetchUsdPrices).toHaveBeenCalledTimes(1)
    })

    it('updates cache only for valid positive prices', async () => {
        const provider = {
            id: 'mock',
            fetchUsdPrices: vi.fn().mockResolvedValue({
                ethereum: { usd: 0 },
                'usd-coin': { usd: -1 },
            }),
        }

        vi.spyOn(Date, 'now').mockReturnValue(10_000)

        await updatePrices(
            {
                providerId: 'mock',
                assetMapping: { eth: 'ethereum', usdc: 'usd-coin' },
                rateTtlMs: 5_000,
                fetchIntervalMs: 0,
            },
            provider,
        )

        expect(lookupUsd('eth')).toBeNull()
        expect(lookupUsd('usdc')).toBeNull()

        const state = getRegistryState()
        expect(Object.keys(state.prices)).toHaveLength(0)
    })

    it('uses fallback ETH/USD price when fetch yields no price', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({}),
        }) as unknown as typeof fetch

        const price = await getEthUsdPrice({
            providerId: 'coingecko',
            assetMapping: { eth: 'ethereum' },
            rateTtlMs: 5_000,
            fetchIntervalMs: 0,
            fallbackEthUsd: '2500',
        })

        expect(price).toBe(2500n * 10n ** 18n)
    })

    it('uses default fallback USD price for pol when provider has no price', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({}),
        }) as unknown as typeof fetch

        const price = await getUsdPrice('pol')

        expect(price).toBe(1n * 10n ** 17n)
    })

    it('uses polygon ecosystem token id for pol by default', async () => {
        const provider = {
            id: 'mock',
            fetchUsdPrices: vi.fn().mockResolvedValue({
                'polygon-ecosystem-token': { usd: '0.5' },
            }),
        }

        await updatePrices(
            {
                providerId: 'mock',
                rateTtlMs: 5_000,
                fetchIntervalMs: 0,
            },
            provider,
        )

        const price = await getUsdPrice('pol', {
            providerId: 'mock',
            rateTtlMs: 5_000,
            fetchIntervalMs: 0,
        })

        expect(provider.fetchUsdPrices).toHaveBeenCalledWith(
            expect.arrayContaining(['polygon-ecosystem-token']),
            expect.any(Object),
        )
        expect(price).toBe(5n * 10n ** 17n)
    })
})
