import {
    DEFAULT_ASSET_MAPPING,
    DEFAULT_COINGECKO_URL,
    DEFAULT_ETH_USD_FALLBACK,
    DEFAULT_FETCH_INTERVAL_MS,
    DEFAULT_FALLBACK_USD_PRICES,
    DEFAULT_PROVIDER_ID,
    DEFAULT_RATE_TTL_MS,
    type AssetMapping,
    type AssetUid,
    type PriceOracleConfig,
} from '../types/price-oracle'
import { logger, getErrorMessage } from '../lib/logger'

type UsdPrice = bigint // scaled by 1e18

export interface RateTick {
    rate: UsdPrice
    timestamp: number
}

export interface PriceRegistry {
    prices: Map<AssetUid, RateTick>
    lastFetch: number
}

type CoinGeckoUsdQuote = {
    usd?: number | string
}

type CoinGeckoSimplePrice = {
    [coinId: string]: CoinGeckoUsdQuote | undefined
}

export interface PriceProvider {
    id: string
    fetchUsdPrices(coinIds: string[], config: ResolvedPriceOracleConfig): Promise<CoinGeckoSimplePrice>
}

interface ResolvedPriceOracleConfig {
    providerId: string
    assetMapping: AssetMapping
    rateTtlMs: number
    fetchIntervalMs: number
    coingeckoUrl: string
    coingeckoApiKey?: string
    fallbackEthUsd: string
    fallbackUsdPrices: Record<AssetUid, string>
}

const PRICE_SCALE = 10n ** 18n

const registry: PriceRegistry = {
    prices: new Map<AssetUid, RateTick>(),
    lastFetch: 0,
}

type PriceOracleConfigInput = PriceOracleConfig | ResolvedPriceOracleConfig

function resolveConfig(config?: PriceOracleConfigInput): ResolvedPriceOracleConfig {
    if (
        config &&
        typeof config.rateTtlMs === 'number' &&
        typeof config.fetchIntervalMs === 'number' &&
        typeof config.providerId === 'string' &&
        config.assetMapping
    ) {
        return config as ResolvedPriceOracleConfig
    }

    return {
        providerId: config?.providerId ?? DEFAULT_PROVIDER_ID,
        assetMapping: config?.assetMapping ?? DEFAULT_ASSET_MAPPING,
        rateTtlMs: config?.rateTtlMs ?? DEFAULT_RATE_TTL_MS,
        fetchIntervalMs: config?.fetchIntervalMs ?? DEFAULT_FETCH_INTERVAL_MS,
        coingeckoUrl: config?.coingeckoUrl ?? DEFAULT_COINGECKO_URL,
        coingeckoApiKey: config?.coingeckoApiKey,
        fallbackEthUsd: config?.fallbackEthUsd ?? DEFAULT_ETH_USD_FALLBACK,
        fallbackUsdPrices: {
            ...DEFAULT_FALLBACK_USD_PRICES,
            ...config?.fallbackUsdPrices,
        },
    }
}

function parseDecimalToScaledBigInt(value: string, scale: number = 18): bigint | null {
    const trimmed = value.trim()

    if (trimmed.length === 0) {
        return null
    }

    const normalized = trimmed.toLowerCase()

    if (!/^[+-]?\d*(\.\d*)?(e[+-]?\d+)?$/.test(normalized)) {
        return null
    }

    let sign = 1n
    let numeric = normalized

    if (numeric.startsWith('-')) {
        sign = -1n
        numeric = numeric.slice(1)
    } else if (numeric.startsWith('+')) {
        numeric = numeric.slice(1)
    }

    let exponent = 0
    const expIndex = numeric.indexOf('e')

    if (expIndex !== -1) {
        exponent = Number.parseInt(numeric.slice(expIndex + 1), 10)
        numeric = numeric.slice(0, expIndex)

        if (!Number.isFinite(exponent)) {
            return null
        }
    }

    const [intPartRaw, fracPartRaw = ''] = numeric.split('.')
    const intPart = intPartRaw.length > 0 ? intPartRaw : '0'
    const fracPart = fracPartRaw ?? ''

    const digits = (intPart + fracPart).replace(/^0+/, '') || '0'
    const fracLen = fracPart.length
    const expShift = exponent - fracLen
    const totalExp = expShift + scale

    if (digits === '0') {
        return 0n
    }

    const digitsBig = BigInt(digits)

    if (totalExp >= 0) {
        return digitsBig * 10n ** BigInt(totalExp) * sign
    }

    const divisor = 10n ** BigInt(-totalExp)
    const quotient = digitsBig / divisor
    const remainder = digitsBig % divisor
    const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient

    return rounded * sign
}

function normalizeUsdPrice(value: unknown): UsdPrice | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const parsed = parseDecimalToScaledBigInt(value.toString(), 18)

        return parsed && parsed > 0n ? parsed : null
    }

    if (typeof value === 'string') {
        const parsed = parseDecimalToScaledBigInt(value, 18)

        return parsed && parsed > 0n ? parsed : null
    }

    return null
}

function getProvider(config: ResolvedPriceOracleConfig): PriceProvider {
    if (config.providerId === 'coingecko') {
        return coingeckoProvider
    }

    throw new Error(`Unsupported price oracle provider: ${config.providerId}`)
}

const coingeckoProvider: PriceProvider = {
    id: 'coingecko',
    async fetchUsdPrices(coinIds: string[], config: ResolvedPriceOracleConfig) {
        const url = new URL(config.coingeckoUrl)
        url.searchParams.set('ids', coinIds.join(','))
        url.searchParams.set('vs_currencies', 'usd')

        if (config.coingeckoApiKey) {
            url.searchParams.set('x_cg_pro_api_key', config.coingeckoApiKey)
        }

        const response = await fetch(url.toString(), {
            headers: {
                Accept: 'application/json',
            },
        })

        if (!response.ok) {
            throw new Error(`CoinGecko error: ${response.status} ${response.statusText}`)
        }

        return response.json<CoinGeckoSimplePrice>()
    },
}

export function lookupUsd(assetUid: AssetUid, config?: PriceOracleConfigInput): UsdPrice | null {
    const resolved = resolveConfig(config)
    const tick = registry.prices.get(assetUid)

    if (!tick) {
        return null
    }

    const age = Date.now() - tick.timestamp

    if (age > resolved.rateTtlMs) {
        logger.debug({ assetUid, age, ttl: resolved.rateTtlMs }, 'price expired')

        return null
    }

    return tick.rate
}

export function lookupConversion(
    fromAsset: AssetUid,
    toAsset: AssetUid,
    config?: PriceOracleConfigInput,
): UsdPrice | null {
    const fromUsd = lookupUsd(fromAsset, config)
    const toUsd = lookupUsd(toAsset, config)

    if (!fromUsd || !toUsd) {
        return null
    }

    if (toUsd === 0n) {
        logger.warn({ toAsset }, 'target asset has zero price')

        return null
    }

    return (fromUsd * PRICE_SCALE) / toUsd
}

export async function updatePrices(
    config?: PriceOracleConfigInput,
    providerOverride?: PriceProvider,
): Promise<void> {
    const resolved = resolveConfig(config)
    const now = Date.now()

    if (now - registry.lastFetch < resolved.fetchIntervalMs) {
        return
    }

    const assetMapping = resolved.assetMapping
    const assetUids = Object.keys(assetMapping)

    if (assetUids.length === 0) {
        return
    }

    const coinIds = Array.from(new Set(Object.values(assetMapping)))
    const provider = providerOverride ?? getProvider(resolved)

    try {
        const response = await provider.fetchUsdPrices(coinIds, resolved)
        let priceCount = 0

        for (const assetUid of assetUids) {
            const coinId = assetMapping[assetUid]
            const entry = response[String(coinId)]

            const usdValue =
                typeof entry === 'object' && entry !== null ? entry.usd : undefined

            const price = normalizeUsdPrice(usdValue)

            if (price && price > 0n) {
                registry.prices.set(assetUid, { rate: price, timestamp: now })
                priceCount++
            }
        }

        registry.lastFetch = now
        logger.debug({ priceCount, coinIds }, 'updated prices from CoinGecko')
    } catch (error) {
        logger.warn({ error: getErrorMessage(error) }, 'failed to fetch prices from CoinGecko')
    }
}

export async function getEthUsdPrice(
    config?: PriceOracleConfigInput,
    fallbackPrice?: string,
): Promise<UsdPrice> {
    const resolved = resolveConfig(config)
    const fallbackValue = fallbackPrice ?? resolved.fallbackEthUsd

    let price = lookupUsd('eth', resolved)

    if (!price) {
        await updatePrices(resolved)
        price = lookupUsd('eth', resolved)
    }

    if (price) {
        return price
    }

    const parsedFallback = parseDecimalToScaledBigInt(fallbackValue, 18)

    if (!parsedFallback || parsedFallback <= 0n) {
        const defaultFallback = parseDecimalToScaledBigInt(DEFAULT_ETH_USD_FALLBACK, 18) ?? 0n
        logger.warn({ fallbackPrice: DEFAULT_ETH_USD_FALLBACK }, 'using fallback ETH/USD price')

        return defaultFallback
    }

    logger.warn({ fallbackPrice: fallbackValue }, 'using fallback ETH/USD price')

    return parsedFallback
}

export async function getUsdPrice(
    assetUid: AssetUid,
    config?: PriceOracleConfigInput,
): Promise<UsdPrice | null> {
    const resolved = resolveConfig(config)
    let price = lookupUsd(assetUid, resolved)

    if (!price) {
        await updatePrices(resolved)
        price = lookupUsd(assetUid, resolved)
    }

    if (price) {
        return price
    }

    const fallbackValue =
        resolved.fallbackUsdPrices[assetUid] ??
        (assetUid === 'eth' ? resolved.fallbackEthUsd : undefined)

    if (!fallbackValue) {
        return null
    }

    const parsedFallback = parseDecimalToScaledBigInt(fallbackValue, 18)

    if (!parsedFallback || parsedFallback <= 0n) {
        return null
    }

    logger.warn({ assetUid, fallbackPrice: fallbackValue }, 'using fallback USD price')

    return parsedFallback
}

export function formatPriceForQuote(usdPrice: UsdPrice): string {
    const normalized = usdPrice < 0n ? 0n : usdPrice

    return `0x${normalized.toString(16)}`
}

export function calculateUsdValue(amount: bigint, usdPrice: UsdPrice, decimals: number): UsdPrice {
    if (decimals < 0) {
        return 0n
    }

    const scale = 10n ** BigInt(decimals)

    return (amount * usdPrice) / scale
}

export function resetPriceRegistry(): void {
    registry.prices.clear()
    registry.lastFetch = 0
}

export function getRegistryState(): { lastFetch: number; prices: Record<string, string> } {
    const prices: Record<string, string> = {}

    for (const [assetUid, tick] of registry.prices.entries()) {
        prices[assetUid] = tick.rate.toString()
    }

    return { lastFetch: registry.lastFetch, prices }
}
