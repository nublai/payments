import { anvil, base, polygon } from 'viem/chains'
import { zeroAddress, type Address } from 'viem'
import { assertRelayerUrl, type EthHttpSigner } from '@nubl/relayer-client'

export type EnvName = 'prod' | 'stage' | 'dev'
export type ChainName = 'base' | 'polygon' | 'anvil'
export type UsdcSymbol = 'USDC' | 'USDC.e'
export type TokenSymbol = 'ETH' | 'USDC'

export type CliNetworkConfig = {
    env: EnvName
    relayerUrl: string
    rpcUrl: string
    chainId: number
    authSigner?: EthHttpSigner
}

type CliChainConfig = {
    chain: ChainName
    viemChain: typeof base | typeof polygon | typeof anvil
    rpcUrl: string
    chainId: number
    ethAddress: Address
    nativeUsdcAddress: Address
    legacyUsdcAddress?: Address
}

export const ETH_ADDRESS = zeroAddress

const DEV_RELAYER_URL_DEFAULT = 'http://127.0.0.1:8787'

function readEnv(name: string): string | undefined {
    const value = process.env[name]?.trim()
    return value ? value : undefined
}

/**
 * Dev defaults to the local wrangler relayer. Prod and stage have no built-in host:
 * set RELAYER_URL_PROD or RELAYER_URL_STAGE. RELAYER_URL_DEV overrides the dev default.
 */

const chainConfig: Record<ChainName, CliChainConfig> = {
    base: {
        chain: 'base',
        viemChain: base,
        rpcUrl: 'https://mainnet.base.org',
        chainId: 8453,
        ethAddress: ETH_ADDRESS,
        nativeUsdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
    polygon: {
        chain: 'polygon',
        viemChain: polygon,
        rpcUrl: 'https://polygon.drpc.org',
        chainId: 137,
        ethAddress: ETH_ADDRESS,
        nativeUsdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        legacyUsdcAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    },
    anvil: {
        chain: 'anvil',
        viemChain: anvil,
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 31337,
        ethAddress: ETH_ADDRESS,
        // Local dev injects MockUSDC bytecode at Base mainnet USDC address.
        nativeUsdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
}

const chainNameByChainId: Partial<Record<number, ChainName>> = Object.values(chainConfig).reduce(
    (acc, config) => {
        acc[config.chainId] = config.chain
        return acc
    },
    {} as Partial<Record<number, ChainName>>,
)

export function getChainNameByChainId(chainId: number): ChainName | undefined {
    return chainNameByChainId[chainId]
}

export function getEnvRelayerUrl(env: EnvName): string {
    const value =
        env === 'dev'
            ? (readEnv('RELAYER_URL_DEV') ?? DEV_RELAYER_URL_DEFAULT)
            : readEnv(env === 'prod' ? 'RELAYER_URL_PROD' : 'RELAYER_URL_STAGE')
    if (!value) {
        const key = env === 'prod' ? 'RELAYER_URL_PROD' : 'RELAYER_URL_STAGE'
        throw new Error(
            `${key} is not set. Set it to the relayer base URL for the ${env} environment.`,
        )
    }
    // Dev may use plain http. Prod and stage must be https unless the host is loopback.
    assertRelayerUrl(value, { allowInsecureHttp: env === 'dev' })
    return value
}

export function getChainConfig(chain: ChainName): CliChainConfig {
    return chainConfig[chain]
}

/** Chains a session unlock must read. Dev is local Anvil; stage and prod are Base and Polygon. */
export function chainsForEnv(env: EnvName): ChainName[] {
    if (env === 'dev') return ['anvil']
    return ['base', 'polygon']
}

/**
 * RPC used for permission reads.
 * `TW_TEST_RPC_<chain>` redirects a chain only when NODE_ENV is test.
 */
export function rpcUrlForChain(chain: ChainName): string {
    if (process.env.NODE_ENV === 'test') {
        const override = process.env[`TW_TEST_RPC_${chain}`]?.trim()
        if (override) return override
    }
    return getChainConfig(chain).rpcUrl
}

export function getUsdcTokenConfig(
    chain: ChainName,
    options?: { legacy?: boolean },
): { symbol: UsdcSymbol; address: Address } {
    const config = getChainConfig(chain)
    if (chain === 'polygon' && options?.legacy && config.legacyUsdcAddress) {
        return {
            symbol: 'USDC.e',
            address: config.legacyUsdcAddress,
        }
    }

    return {
        symbol: 'USDC',
        address: config.nativeUsdcAddress,
    }
}

export function getTokenAddress(
    token: TokenSymbol,
    chain: ChainName,
    options?: { legacy?: boolean },
): Address {
    if (token === 'ETH') {
        return getChainConfig(chain).ethAddress
    }
    return getUsdcTokenConfig(chain, options).address
}

export function getTokenDecimals(token: TokenSymbol): number {
    return token === 'ETH' ? 18 : 6
}

export function normalizeTokenSymbol(value: string): TokenSymbol {
    const normalized = value.trim().toUpperCase()
    if (normalized === 'ETH' || normalized === 'USDC') {
        return normalized
    }
    throw new Error(`Unsupported token: ${value}`)
}

export function resolveNetworkConfig(env: EnvName, chain: ChainName): CliNetworkConfig {
    const selected = getChainConfig(chain)
    return {
        env,
        relayerUrl: getEnvRelayerUrl(env),
        rpcUrl: selected.rpcUrl,
        chainId: selected.chainId,
    }
}

export function getUsdcAddressByChainId(chainId: number, legacy = false): Address | undefined {
    const chain = getChainNameByChainId(chainId)
    if (!chain) {
        return undefined
    }
    return getUsdcTokenConfig(chain, { legacy }).address
}

export function normalizeChainName(value?: string): ChainName {
    if (!value || value === 'base') {
        return 'base'
    }
    if (value === 'polygon' || value === 'matic') {
        return 'polygon'
    }
    if (value === 'anvil' || value === 'local') {
        return 'anvil'
    }
    throw new Error(`Unsupported chain: ${value}`)
}

export function selectDefaultChain(env: EnvName, chainValue?: string): ChainName {
    if (chainValue) {
        return normalizeChainName(chainValue)
    }
    return env === 'dev' ? 'anvil' : 'base'
}
