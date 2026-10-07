import type { ContractAddresses } from '@nubl/contracts/deployments'
import type { BundleStatusDO } from '../durable-objects/bundle-status.do'
import type { HttpAuthNonceDO } from '../durable-objects/http-auth-nonce.do'
import type { IntentNonceDO } from '../durable-objects/intent-nonce.do'
import type { SignerDO } from '../durable-objects/signer.do'
import type { SignerPoolDO } from '../durable-objects/signer-pool.do'
import type { WalletBindingDO } from '../durable-objects/wallet-binding.do'
import {
    DEFAULT_ASSET_MAPPING,
    DEFAULT_COINGECKO_URL,
    DEFAULT_ETH_USD_FALLBACK,
    DEFAULT_FALLBACK_USD_PRICES,
    DEFAULT_FETCH_INTERVAL_MS,
    DEFAULT_PROVIDER_ID,
    DEFAULT_RATE_TTL_MS,
    type PriceOracleConfig,
} from './price-oracle'

/**
 * Cloudflare Worker environment bindings
 */

export interface Env {
    // Durable Objects - Signer Pool
    SIGNER: DurableObjectNamespace<SignerDO>
    SIGNER_POOL: DurableObjectNamespace<SignerPoolDO>

    // Durable Objects - Intent Nonce
    INTENT_NONCE_MANAGER: DurableObjectNamespace<IntentNonceDO>

    // Queue for transaction monitoring
    MONITOR_QUEUE: Queue

    // Durable Objects - Bundle Status
    BUNDLE_STATUS_DO?: DurableObjectNamespace<BundleStatusDO>
    HTTP_AUTH_NONCE_MANAGER?: DurableObjectNamespace<HttpAuthNonceDO>
    /** Single global object. See WalletBindingDO. */
    WALLET_BINDING?: DurableObjectNamespace<WalletBindingDO>

    // Required secrets
    RPC_URL?: string
    // Multi-chain support (comma-separated list of chain IDs)
    CHAIN_IDS?: string

    // Chain-specific RPC URLs (e.g., RPC_84532, RPC_8453)
    // Pattern: RPC_<chainId> overrides RPC_URL for that chain
    [key: `RPC_${string}`]: string | undefined

    // Mnemonic-based signing (required)
    RELAYER_MNEMONIC: string

    // Pool configuration
    RELAYER_COUNT?: string // Default: "1"
    MAX_PENDING_PER_SIGNER?: string // Default: "16"
    MAX_PENDING_TOTAL?: string // Default: "1000"
    MIN_SIGNER_BALANCE?: string // Default: "10000000000000000" (0.01 ETH in wei)
    TARGET_SIGNER_BALANCE?: string // Target balance after pullGas refill (ETH, e.g. "0.01")
    REPLACEMENT_BUMP_BPS?: string // Replacement fee bump in bps (default: "1250" => 12.5%)
    REPLACEMENT_TRIGGER_THRESHOLD_WEI?: string // Additional fee delta required to trigger replacement
    REPLACEMENT_MAX_ATTEMPTS?: string // Maximum replacement attempts before abandoned (default: "3")
    REPLACEMENT_BACKOFF_BASE_MS?: string // Base backoff in ms for exponential retry (default: "30000")
    REPLACEMENT_MAX_FEE_PER_GAS_WEI?: string // Optional hard cap for maxFee/maxPriority during replacement
    BUNDLE_UNRESOLVED_SLA_MS?: string // Max age in ms for unresolved bundle mappings before terminal failure

    // Optional overrides (derived from deployment if not set)
    // Names match @nubl/contracts env var keys (no _ADDRESS suffix)
    ACCOUNT?: string
    ACCOUNT_PROXY?: string
    ORCHESTRATOR?: string
    SIMPLE_FUNDER?: string
    SIMULATOR?: string
    CONTEXT?: string // Deployment context: "prod", "stage", "local" (default: "prod")

    // Fee configuration
    FEE_RECIPIENT?: string // Address to receive fees (defaults to signer address)
    PRIORITY_FEE_PERCENTILE?: string // Percentile from fee history (default: "50")
    QUOTE_TTL_SECONDS?: string // Quote TTL in seconds (default: "300")

    // Gas calculation configuration (see audit/prepare-intent-review.md for details)
    INTENT_GAS_BUFFER?: string // Fixed buffer added to simulation gas for combinedGas (default: "0")
    PAYMENT_GAS_BUFFER?: string // Additional combinedGas buffer when payment reimbursement is enabled
    ORCHESTRATOR_OVERHEAD?: string // Gas for orchestrator work outside self-call (default: "110000")
    TX_GAS_BUFFER?: string // Additional buffer for txGas calculation (default: "0")

    // Simulation fallback configuration
    // If "true", use default gas when simulation fails (not recommended for production)
    // If "false" (default), fail the request when simulation fails
    ALLOW_SIMULATION_FALLBACK?: string

    // Intent expiry configuration
    INTENT_EXPIRY_BUFFER_SECONDS?: string // Buffer before expiry to reject intent (default: "30")

    // HMAC-SHA256 secret for quote integrity.
    // Required when CONTEXT is not local/dev. When unset locally, quote HMAC is skipped.
    // Set with `wrangler secret put QUOTE_SIGNING_SECRET --env <stage|prod>`. Do not commit the value.
    QUOTE_SIGNING_SECRET?: string

    // CORS allowed origins. Comma-separated list. Unset or "*" allows every origin.
    // If not set or set to "*", allows all origins (permissive mode)
    CORS_ALLOWED_ORIGINS?: string

    // Shared auth policy for all enabled auth mechanisms
    AUTH_PROTECTED_METHODS?: string

    // ERC-8128 HTTP authentication
    ERC8128_ENABLED?: string
    ERC8128_MAX_VALIDITY_SECONDS?: string
    ERC8128_CLOCK_SKEW_SECONDS?: string
    // Comma-separated addresses. Outside local/dev, a recovered key is accepted when it is
    // listed here, or when it is the intent EOA, or when it is a live on-chain key of that
    // account. A client-supplied session_key or authSigner is not enough. An empty list is
    // not "anyone". Other protected methods in the same JSON-RPC batch require this list.
    ERC8128_ALLOWED_SIGNERS?: string

    // Privy authentication. Unset enables Privy. `false` turns it off.
    PRIVY_ENABLED?: string
    PRIVY_APP_ID?: string
    PRIVY_APP_SECRET?: string

    // OIDC authentication. Public config, not secrets. WorkOS is the first issuer.
    // When OIDC_ENABLED=true, issuer, JWKS URL, and client id are all required.
    OIDC_ENABLED?: string
    OIDC_ISSUER?: string
    OIDC_JWKS_URL?: string
    OIDC_CLIENT_ID?: string
    /** JWT claim that lists wallet addresses. Defaults to `wallets`. */
    OIDC_WALLETS_CLAIM?: string

    /**
     * Cap on paymentMaxAmount for a USDC-paid first upgrade, in fee-token base
     * units. Unset uses 10 USDC (6 decimals). See DEFAULT_PAID_UPGRADE_MAX_PAYMENT.
     */
    PAID_UPGRADE_MAX_PAYMENT?: string

    // Price oracle configuration
    PRICE_ORACLE_PROVIDER?: string // Default: "coingecko"
    PRICE_RATE_TTL_SECONDS?: string // Default: "300"
    PRICE_FETCH_INTERVAL_SECONDS?: string // Default: "60"
    PRICE_ASSET_MAPPING?: string // JSON map: { "usdc": "usd-coin", ... }
    PRICE_ASSET_FALLBACKS?: string // JSON map: { "usdc": "1", ... }
    PRICE_ETH_USD_FALLBACK?: string // Default: "3000"

    // CoinGecko configuration (provider-specific)
    COINGECKO_API_KEY?: string
    COINGECKO_API_URL?: string
}

/**
 * Relayer configuration derived from environment
 */
export interface RelayerConfig {
    rpcUrl: string
    chainId: number
    contracts: ContractAddresses
}

/**
 * Pool configuration for SignerDO/SignerPoolDO
 */
export interface SignerPoolConfig {
    rpcUrl: string
    chainId: number
    mnemonic: string
    signerCount: number
    maxPendingPerSigner: number
    maxPendingTotal: number
    minSignerBalance: bigint
    contracts: ContractAddresses
}

/**
 * Fee configuration for payment estimation
 */
export interface FeeConfig {
    /** Address to receive fees (undefined = signer self-reimburses) */
    feeRecipient?: string
    /** Percentile from fee history for priority fee (e.g., 50 for median) */
    priorityFeePercentile: number
    /** Quote TTL in seconds */
    quoteTtlSeconds: number
}

/**
 * Gas calculation configuration
 *
 * See audit/prepare-intent-review.md for detailed explanation of gas handling.
 *
 * combinedGas = simulationGas + intentGasBuffer  (goes in signed EIP-712 message)
 * txGas = ((combinedGas + orchestratorOverhead + txGasBuffer) * 64/63) + intrinsicGas  (for broadcasting)
 */
export interface GasConfig {
    /** Fixed buffer added to simulation gas for combinedGas (default: 0) */
    intentGasBuffer: bigint
    /** Additional buffer for payment-enabled intents (default: 70_000) */
    paymentGasBuffer: bigint
    /** Gas for orchestrator work outside the gas-limited self-call (default: 110_000) */
    orchestratorOverhead: bigint
    /** Additional buffer for txGas calculation (default: 0) */
    txGasBuffer: bigint
    /** If true, use default gas when simulation fails (default: false) */
    allowSimulationFallback: boolean
}

/**
 * Parse fee config from environment
 */
export function getFeeConfig(env: Env): FeeConfig {
    return {
        feeRecipient: env.FEE_RECIPIENT,
        priorityFeePercentile: parseInt(env.PRIORITY_FEE_PERCENTILE ?? '50', 10),
        quoteTtlSeconds: parseInt(env.QUOTE_TTL_SECONDS ?? '300', 10),
    }
}

/**
 * Parse gas config from environment
 *
 * Note: INTENT_GAS_BUFFER default of 50000 accounts for session key operations.
 * Simulation uses keyHash=0 (owner key) which bypasses GuardedExecutor spending
 * checks. Real session key execution needs extra gas for _incrementSpent storage
 * operations and canExecute checks.
 */
export function getGasConfig(env: Env): GasConfig {
    return {
        intentGasBuffer: BigInt(env.INTENT_GAS_BUFFER ?? '50000'),
        paymentGasBuffer: BigInt(env.PAYMENT_GAS_BUFFER ?? '70000'),
        orchestratorOverhead: BigInt(env.ORCHESTRATOR_OVERHEAD ?? '110000'),
        txGasBuffer: BigInt(env.TX_GAS_BUFFER ?? '0'),
        allowSimulationFallback: env.ALLOW_SIMULATION_FALLBACK === 'true',
    }
}

function parseJsonRecord(envValue: string | undefined, label: string): Record<string, string> {
    if (!envValue) {
        return {}
    }
    try {
        const parsed = JSON.parse(envValue) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('expected JSON object')
        }
        const record: Record<string, string> = {}
        for (const [key, value] of Object.entries(parsed)) {
            record[String(key)] = String(value)
        }
        return record
    } catch (error) {
        throw new Error(
            `Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

/**
 * Parse price oracle configuration from environment
 */
export function getPriceOracleConfig(env: Env): PriceOracleConfig {
    const rateTtlSeconds = parseInt(env.PRICE_RATE_TTL_SECONDS ?? '', 10)
    const fetchIntervalSeconds = parseInt(env.PRICE_FETCH_INTERVAL_SECONDS ?? '', 10)

    const assetMapping = {
        ...DEFAULT_ASSET_MAPPING,
        ...parseJsonRecord(env.PRICE_ASSET_MAPPING, 'PRICE_ASSET_MAPPING'),
    }

    const fallbackUsdPrices = {
        ...DEFAULT_FALLBACK_USD_PRICES,
        ...parseJsonRecord(env.PRICE_ASSET_FALLBACKS, 'PRICE_ASSET_FALLBACKS'),
    }

    return {
        providerId: env.PRICE_ORACLE_PROVIDER ?? DEFAULT_PROVIDER_ID,
        assetMapping,
        rateTtlMs: Number.isFinite(rateTtlSeconds) ? rateTtlSeconds * 1000 : DEFAULT_RATE_TTL_MS,
        fetchIntervalMs: Number.isFinite(fetchIntervalSeconds)
            ? fetchIntervalSeconds * 1000
            : DEFAULT_FETCH_INTERVAL_MS,
        coingeckoUrl: env.COINGECKO_API_URL ?? DEFAULT_COINGECKO_URL,
        coingeckoApiKey: env.COINGECKO_API_KEY,
        fallbackEthUsd: env.PRICE_ETH_USD_FALLBACK ?? DEFAULT_ETH_USD_FALLBACK,
        fallbackUsdPrices,
    }
}
