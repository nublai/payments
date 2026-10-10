export type AssetUid = string

export type AssetMapping = Record<AssetUid, string>

export interface PriceOracleConfig {
    providerId?: string
    assetMapping?: AssetMapping
    rateTtlMs?: number
    fetchIntervalMs?: number
    coingeckoUrl?: string
    coingeckoApiKey?: string
    fallbackEthUsd?: string
    fallbackUsdPrices?: Record<AssetUid, string>
}

export const DEFAULT_ASSET_MAPPING = {
    eth: 'ethereum',
    pol: 'polygon-ecosystem-token',
    weth: 'ethereum',
    usdc: 'usd-coin',
    usdt: 'tether',
} as const satisfies AssetMapping

export const DEFAULT_RATE_TTL_MS = 300_000

export const DEFAULT_FETCH_INTERVAL_MS = 60_000

export const DEFAULT_PROVIDER_ID = 'coingecko'

export const DEFAULT_COINGECKO_URL = 'https://pro-api.coingecko.com/api/v3/simple/price'

export const DEFAULT_ETH_USD_FALLBACK = '3000'

export const DEFAULT_FALLBACK_USD_PRICES = {
    pol: '0.1',
    usdc: '1',
    usdt: '1',
} as const satisfies Record<'pol' | 'usdc' | 'usdt', string>
